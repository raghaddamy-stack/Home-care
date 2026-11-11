// Home-care path: assessment → episode → care plan → orders → results → roster → shifts → escalation → discharge.
import { Router } from 'express';
import { z } from 'zod';
import { cfg, escalationRecipients } from '../settings.js';
import type { Db, Row } from '../db.js';
import { needsEscalation, scoreNews2 } from '../domain/news2.js';
import { billableMinutes, buildRoster, distanceMetres, isLate, SHIFT_PATTERNS, workingTimeViolations, type TimeSlot } from '../domain/shifts.js';
import { dueAt, isOverdue, timerFor } from '../domain/escalation.js';
import { audit, getOr404, HttpError, notify, now, requireRole, wrap, wrapAsync, requireStaff } from '../http.js';
import { assertStaffAvailable, genderCheck, setStatus } from './requests.js';
import { servicePrice } from './lifecycle.js';
import { ensureStock, itemsFor, queueGoodsIssue } from '../stock.js';
import { ConsentInput, ensureConsent } from './consent.js';

/**
 * BR-33 check for one nurse: existing open/completed shifts in the surrounding fortnight plus the new ones.
 * A supervisor may override with a reason (hard warning, not a hard stop); the override is audited.
 */
function assertWorkingTime(db: Db, nurseId: number, proposed: TimeSlot[], override: { by?: Row; reason?: string }, excludeShiftId?: number) {
  if (proposed.length === 0) return;
  const from = new Date(Math.min(...proposed.map((p) => p.start.getTime())) - 8 * 86_400_000).toISOString();
  const to = new Date(Math.max(...proposed.map((p) => p.end.getTime())) + 8 * 86_400_000).toISOString();
  const existing = db.all(
    `SELECT planned_start, planned_end FROM shifts WHERE nurse_id = ? AND status IN ('PLANNED','LATE','CHECKED_IN','COMPLETED')
     AND planned_end > ? AND planned_start < ? AND id != ?`,
    nurseId, from, to, excludeShiftId ?? 0,
  ).map((s) => ({ start: new Date(s.planned_start), end: new Date(s.planned_end) }));
  const problems = workingTimeViolations([...existing, ...proposed]);
  if (problems.length === 0) return;
  if (override.reason && override.by && ['SUPERVISOR', 'ADMIN'].includes(override.by.role)) {
    audit(db, override.by.id, 'WORKING_TIME_OVERRIDE', 'staff', nurseId, { problems, reason: override.reason });
    return;
  }
  throw new HttpError(409, `Nurse ${nurseId} working-time limits (BR-33): ${problems.join('; ')}. A nursing supervisor can override with a reason.`);
}

/** Open an escalation with its response deadline (§5.5). HIGH goes to the medical director at once. */
function openEscalation(db: Db, episodeId: number, trigger: string, level: string, action: string, at: Date, refId?: number) {
  const due = dueAt(trigger, level, at);
  const immediate = due !== null && due.getTime() <= at.getTime();
  const id = db.insert('escalations', {
    episode_id: episodeId, trigger, level, action, ref_id: refId, opened_at: at, due_at: due ?? undefined,
    escalated_at: immediate ? at : undefined, escalated_to: immediate ? timerFor(trigger, level)!.escalateTo : undefined,
  });
  if (immediate) for (const rcpt of escalationRecipients(timerFor(trigger, level)!.escalateTo)) notify(db, rcpt, 'CALL', `${trigger} ${level} escalation #${id}: review now`);
  return id;
}

/**
 * Timer sweep (§5.5), run by the scheduler every minute:
 * - open escalations past their deadline go up to the medical director (or nursing supervisor for late shifts);
 * - critical results not acknowledged within 30 min of validation are escalated the same way (also outpatient ones);
 * - NEWS2 5–6 with no new vitals within 15 min: the nurse is told to recheck;
 * - non-critical results the doctor has not reviewed are released to the patient after 24 h.
 */
/** Flag shifts whose nurse has not checked in after the grace period (also run by the server every few minutes). */
export function checkLateShifts(db: Db, t: Date): number[] {
  const open = db.all(`SELECT s.* FROM shifts s JOIN episodes e ON e.id = s.episode_id WHERE s.status = 'PLANNED' AND e.status = 'ACTIVE' AND s.planned_start <= ?`, t.toISOString());
  const late = open.filter((s) => isLate(new Date(s.planned_start), null, t));
  db.tx(() => {
    for (const s of late) {
      db.update('shifts', s.id, { status: 'LATE' });
      openEscalation(db, s.episode_id, 'LATE_SHIFT', 'OPS', 'Call nurse; send backup if no ETA in 15 min', t, s.id);
      notify(db, 'role:COORDINATOR', 'PUSH', `Shift ${s.id}: nurse not checked in, send a backup`);
    }
  });
  return late.map((s) => s.id);
}

export function runEscalationTimers(db: Db, at: Date) {
  const iso = at.toISOString();
  const escalated: number[] = [];
  const recheck: number[] = [];
  const escalatedResults: number[] = [];
  db.tx(() => {
    for (const e of db.all<any>(`SELECT * FROM escalations WHERE status = 'OPEN' AND due_at IS NOT NULL AND escalated_at IS NULL AND due_at <= ?`, iso)) {
      if (!isOverdue(e, at)) continue;
      const to = timerFor(e.trigger, e.level)!.escalateTo;
      db.update('escalations', e.id, { escalated_at: at, escalated_to: to });
      for (const rcpt of escalationRecipients(to)) notify(db, rcpt, 'CALL', `Escalation #${e.id} (${e.trigger} ${e.level}) not answered in time: respond now`);
      if (e.trigger === 'CRITICAL_RESULT' && e.ref_id) db.update('results', e.ref_id, { escalated_at: at });
      escalated.push(e.id);
    }
    const cutoff = new Date(at.getTime() - cfg().criticalResultAckMin * 60_000).toISOString();
    for (const r of db.all(`SELECT * FROM results WHERE critical = 1 AND acknowledged_by IS NULL AND escalated_at IS NULL AND created_at <= ?`, cutoff)) {
      db.update('results', r.id, { escalated_at: at });
      for (const rcpt of escalationRecipients('MEDICAL_DIRECTOR')) notify(db, rcpt, 'CALL', `Critical result #${r.id} not acknowledged within ${cfg().criticalResultAckMin} min: call the patient now`);
      escalatedResults.push(r.id);
    }
    const recheckCutoff = new Date(at.getTime() - cfg().news2RecheckMin * 60_000).toISOString();
    for (const e of db.all(
      `SELECT x.*, v.shift_id, v.at AS reading_at FROM escalations x JOIN vitals v ON v.id = x.ref_id
       WHERE x.trigger = 'NEWS2' AND x.level = 'MEDIUM' AND x.status != 'RESOLVED' AND v.at <= ?
       AND x.recheck_requested_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM vitals n WHERE n.episode_id = x.episode_id AND n.at > v.at)`,
      recheckCutoff,
    )) {
      db.update('escalations', e.id, { recheck_requested_at: at });
      const nurse = e.shift_id ? db.get<{ nurse_id: number }>('SELECT nurse_id FROM shifts WHERE id = ?', e.shift_id)?.nurse_id : undefined;
      notify(db, nurse ? `staff:${nurse}` : 'role:NURSE', 'PUSH', `Recheck vitals now (escalation #${e.id}): NEWS2 5-6 needs a repeat reading within ${cfg().news2RecheckMin} min`);
      recheck.push(e.id);
    }
    // resultAutoReleaseH = 0 means results reach the patient only after the doctor reviews them.
    const releaseCutoff = new Date(at.getTime() - cfg().resultAutoReleaseH * 3600_000).toISOString();
    if (cfg().resultAutoReleaseH > 0) db.run(`UPDATE results SET released_at = ? WHERE critical = 0 AND released_at IS NULL AND acknowledged_by IS NULL AND created_at <= ?`, iso, releaseCutoff);
  });
  return { escalated, escalatedResults, recheck };
}

/** The episode doctor, or the configured on-call doctors when the episode has none. */
function notifyDoctor(db: Db, doctorId: number | null, channel: 'CALL' | 'PUSH', message: string) {
  const to = doctorId ? [`staff:${doctorId}`] : escalationRecipients('ONCALL_DOCTOR');
  for (const r of to) notify(db, r, channel, message);
}

function nurseShift(db: Db, req: any): { shift: Row; staff: Row } {
  const staff = requireRole(db, req, 'NURSE', 'COORDINATOR', 'SUPERVISOR');
  const shift = getOr404(db, 'shifts', req.params.id, 'Shift');
  if (staff.role === 'NURSE' && shift.nurse_id !== staff.id) throw new HttpError(403, 'Not your shift');
  return { shift, staff };
}

const VitalsInput = z.object({
  respRate: z.number(),
  spo2: z.number(),
  spo2Scale: z.union([z.literal(1), z.literal(2)]).optional(),
  onOxygen: z.boolean(),
  systolicBp: z.number(),
  heartRate: z.number(),
  consciousness: z.enum(['A', 'C', 'V', 'P', 'U']),
  temperature: z.number(),
});

export function clinicalRoutes(db: Db): Router {
  const r = Router();

  // ---- Episode of care -------------------------------------------------------
  // Doctor / nurse finishes the assessment visit: open the episode or refer out.
  r.post('/episodes', wrap((req, res) => {
    const staff = requireRole(db, req, 'DOCTOR', 'NURSE');
    const body = z.object({
      requestId: z.number().int(),
      diagnosis: z.string().min(2),
      history: z.string().optional(),
      fallRiskScore: z.number().int().optional(),
      bradenScore: z.number().int().min(6).max(23).optional(),
      suitable: z.boolean(),
      referReason: z.string().optional(),
      billingCycle: z.enum(['WEEKLY', 'MONTHLY']).default('WEEKLY'),
      shiftServiceCode: z.string().default('NRS-HOUR'),
      allergies: z.array(z.string()).optional(),
      chronicConditions: z.array(z.string()).optional(),
    }).parse(req.body);
    const request = getOr404(db, 'service_requests', body.requestId, 'Request');
    if (request.status !== 'IN_PROGRESS') throw new HttpError(409, 'The assessment visit must be checked in');

    const out = db.tx(() => {
      const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM episodes')!.n + 1;
      const episodeId = db.insert('episodes', {
        episode_no: `EP-${String(n).padStart(6, '0')}`, patient_id: request.patient_id, request_id: request.id,
        doctor_id: staff.role === 'DOCTOR' ? staff.id : undefined, diagnosis: body.diagnosis,
        status: body.suitable ? 'ACTIVE' : 'REFERRED_OUT', billing_cycle: body.billingCycle,
        shift_service_code: body.shiftServiceCode, policy_id: request.policy_id, started_at: now(req),
      });
      db.insert('assessments', {
        episode_id: episodeId, by_staff_id: staff.id, history: body.history,
        fall_risk_score: body.fallRiskScore, braden_score: body.bradenScore, suitable: body.suitable,
      });
      if (body.allergies || body.chronicConditions) {
        db.update('patients', request.patient_id, { allergies: body.allergies, chronic_conditions: body.chronicConditions });
      }
      db.run(`UPDATE visits SET status = 'COMPLETED', completed_at = ? WHERE request_id = ? AND status = 'CHECKED_IN'`, now(req).toISOString(), request.id);
      if (body.suitable) setStatus(db, request, 'CONVERTED_TO_EPISODE', staff.id);
      else {
        setStatus(db, request, 'REFERRED_OUT', staff.id, body.referReason);
        notify(db, `patient:${request.patient_id}`, 'CALL', `Home care not suitable: ${body.referReason ?? 'referred to hospital/clinic'}`);
      }
      audit(db, staff.id, 'OPEN_EPISODE', 'episodes', episodeId);
      return getOr404(db, 'episodes', episodeId);
    });
    res.status(201).json(out);
  }));

  r.get('/episodes/:id', wrap((req) => {
    requireStaff(db, req);
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    return {
      ...ep,
      patient: db.get('SELECT * FROM patients WHERE id = ?', ep.patient_id),
      assessments: db.all('SELECT * FROM assessments WHERE episode_id = ?', ep.id),
      carePlan: db.get('SELECT * FROM care_plans WHERE episode_id = ? ORDER BY version DESC LIMIT 1', ep.id),
      orders: db.all('SELECT * FROM orders WHERE episode_id = ?', ep.id),
      results: db.all('SELECT r.* FROM results r JOIN orders o ON o.id = r.order_id WHERE o.episode_id = ?', ep.id),
      shifts: db.all('SELECT * FROM shifts WHERE episode_id = ? ORDER BY planned_start', ep.id),
      vitals: db.all('SELECT * FROM vitals WHERE episode_id = ? ORDER BY at DESC LIMIT 50', ep.id),
      escalations: db.all('SELECT * FROM escalations WHERE episode_id = ? ORDER BY id DESC', ep.id),
    };
  }));

  r.post('/episodes/:id/care-plan', wrap((req) => {
    const staff = requireRole(db, req, 'DOCTOR');
    const body = z.object({
      shiftHours: z.union([z.literal(8), z.literal(12), z.literal(24)]),
      hoursPerDay: z.number().int().min(1).max(24),
      durationDays: z.number().int().min(1),
      goals: z.string().optional(),
    }).parse(req.body);
    if (body.hoursPerDay % body.shiftHours !== 0) throw new HttpError(400, `hoursPerDay must be a multiple of ${body.shiftHours} (${SHIFT_PATTERNS.join('/')}h shifts)`);
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    if (ep.status !== 'ACTIVE') throw new HttpError(409, `Episode is ${ep.status}`);
    const version = db.get<{ v: number }>('SELECT COALESCE(MAX(version),0) AS v FROM care_plans WHERE episode_id = ?', ep.id)!.v + 1;
    const id = db.insert('care_plans', {
      episode_id: ep.id, version, shift_hours: body.shiftHours, hours_per_day: body.hoursPerDay,
      duration_days: body.durationDays, goals: body.goals, approved_by: staff.id,
    });
    notify(db, 'role:COORDINATOR', 'PUSH', `${ep.episode_no}: care plan v${version} ready, build the roster`);
    return { id, version };
  }));

  // ---- Orders and results ----------------------------------------------------
  r.post('/episodes/:id/orders', wrap((req, res) => {
    const staff = requireRole(db, req, 'DOCTOR', 'NURSE');
    const body = z.object({ serviceCode: z.string(), priority: z.enum(['ROUTINE', 'URGENT', 'STAT']).default('ROUTINE'), notes: z.string().optional() }).parse(req.body);
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    if (ep.status !== 'ACTIVE') throw new HttpError(409, `Episode is ${ep.status}`);
    const svc = db.get('SELECT * FROM services WHERE code = ?', body.serviceCode);
    if (!svc) throw new HttpError(400, `Unknown service ${body.serviceCode}`);
    const id = db.insert('orders', { episode_id: ep.id, service_code: svc.code, department: svc.department, priority: body.priority, ordered_by: staff.id, notes: body.notes, created_at: now(req) });
    notify(db, `dept:${svc.department}`, 'PUSH', `${body.priority} order #${id} (${svc.name_en}) for ${ep.episode_no}`);
    res.status(201).json({ id, department: svc.department });
  }));

  // Department worklist.
  r.get('/orders', wrap((req) => {
    requireStaff(db, req);
    const dept = req.query.department as string | undefined;
    return db.all(
      `SELECT o.*, s.name_en, s.name_ar FROM orders o JOIN services s ON s.code = o.service_code
       WHERE (? IS NULL OR o.department = ?) AND o.status IN ('PLACED','ACCEPTED','IN_PROGRESS')
       ORDER BY CASE o.priority WHEN 'STAT' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END, o.id`,
      dept ?? null, dept ?? null,
    );
  }));

  r.post('/orders/:id/accept', wrap((req) => {
    requireRole(db, req, 'LAB_TECH', 'RADIOGRAPHER', 'PHARMACIST', 'DRIVER');
    const o = getOr404(db, 'orders', req.params.id, 'Order');
    if (o.status !== 'PLACED') throw new HttpError(409, `Order is ${o.status}`);
    db.update('orders', o.id, { status: 'ACCEPTED' });
    return { status: 'ACCEPTED' };
  }));

  r.post('/orders/:id/result', wrapAsync(async (req, res) => {
    const staff = requireRole(db, req, 'LAB_TECH', 'RADIOGRAPHER', 'PHARMACIST', 'DRIVER');
    const body = z.object({
      report: z.string().min(1), critical: z.boolean().default(false), serialNo: z.string().optional(),
      // What the pharmacy / store actually dispensed; defaults to the service's mapped material.
      stockItems: z.array(z.object({ material: z.string().min(1), qty: z.number().positive() })).optional(),
    }).parse(req.body);
    const o = getOr404(db, 'orders', req.params.id, 'Order');
    if (!['PLACED', 'ACCEPTED', 'IN_PROGRESS'].includes(o.status)) throw new HttpError(409, `Order is ${o.status}`);
    const at = now(req);
    // Home-care order (episode) or a sample / scan taken on an outpatient visit and resulted later (request).
    const ep = o.episode_id ? getOr404(db, 'episodes', o.episode_id, 'Episode') : undefined;
    const request = !ep && o.request_id ? getOr404(db, 'service_requests', o.request_id, 'Request') : undefined;
    const patientId = ep?.patient_id ?? request?.patient_id;
    if (!patientId) throw new HttpError(409, 'Order has no patient');
    const stockItems = itemsFor(o.service_code, 1, body.stockItems);
    const stock = await ensureStock(db, stockItems);
    const out = db.tx(() => {
      queueGoodsIssue(db, stockItems, { reference: `ORDER-${o.id}`, serviceCode: o.service_code, patientId, staffId: staff.id });
      const id = db.insert('results', {
        order_id: o.id, patient_id: patientId, report: body.report, critical: body.critical, validated_by: staff.id, created_at: at,
        // Outpatient results go to the patient straight away unless critical (same rule as at the visit).
        released_at: !ep && !body.critical ? at : undefined,
      });
      db.update('orders', o.id, { status: 'VALIDATED' });
      if (ep && o.department === 'EQUIPMENT') {
        // Delivered device: the rental starts now and is billed by day with the episode's invoices.
        const policy = ep.policy_id ? db.get<{ payer_id: number }>('SELECT payer_id FROM insurance_policies WHERE id = ?', ep.policy_id) : undefined;
        db.insert('rentals', {
          patient_id: ep.patient_id, episode_id: ep.id, service_code: o.service_code, serial_no: body.serialNo, start_date: at,
          expected_return: new Date(at.getTime() + 30 * 86_400_000), daily_rate: servicePrice(db, o.service_code, policy?.payer_id ?? null), deposit: 0,
        });
      }
      if (ep && body.critical) {
        openEscalation(db, ep.id, 'CRITICAL_RESULT', 'CRITICAL', 'Doctor must acknowledge within 30 min', at, id);
        notifyDoctor(db, ep.doctor_id, 'CALL', `CRITICAL result for ${ep.episode_no}`);
      } else if (ep) {
        notifyDoctor(db, ep.doctor_id, 'PUSH', `Result ready for review (${ep.episode_no})`);
      } else if (body.critical) {
        for (const rcpt of escalationRecipients('ONCALL_DOCTOR')) notify(db, rcpt, 'CALL', `CRITICAL result for ${request!.request_no}: acknowledge result ${id}`);
      } else {
        notify(db, `patient:${patientId}`, 'PUSH', 'Your result is ready');
      }
      return { id, critical: body.critical, stockWarnings: stock.warnings };
    });
    res.status(201).json(out);
    return undefined;
  }));

  // Doctor reviews the result in the EMR; it is then released to the patient app.
  r.post('/results/:id/acknowledge', wrap((req) => {
    const staff = requireRole(db, req, 'DOCTOR');
    const result = getOr404(db, 'results', req.params.id, 'Result');
    return db.tx(() => {
      db.update('results', result.id, { acknowledged_by: staff.id, released_at: result.released_at ?? now(req) });
      db.update('orders', result.order_id, { status: 'ACKNOWLEDGED' });
      db.run(`UPDATE escalations SET status = 'RESOLVED', acked_by = ?, closed_at = ? WHERE trigger = 'CRITICAL_RESULT' AND ref_id = ? AND status != 'RESOLVED'`, staff.id, now(req).toISOString(), result.id);
      notify(db, `patient:${result.patient_id}`, 'PUSH', 'A new result is available in your file');
      return { status: 'ACKNOWLEDGED' };
    });
  }));

  // ---- Roster and shifts -----------------------------------------------------
  r.post('/episodes/:id/roster', wrap((req, res) => {
    const staff = requireRole(db, req, 'COORDINATOR', 'SUPERVISOR');
    const body = z.object({
      start: z.string().datetime(), nurseIds: z.array(z.number().int()).min(1), days: z.number().int().min(1).optional(),
      overrideReason: z.string().min(5).optional(),
    }).parse(req.body);
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    if (ep.status !== 'ACTIVE') throw new HttpError(409, `Episode is ${ep.status}`);
    const plan = db.get('SELECT * FROM care_plans WHERE episode_id = ? ORDER BY version DESC LIMIT 1', ep.id);
    if (!plan) throw new HttpError(409, 'The doctor has not approved a care plan yet');
    const start = new Date(body.start);
    const warnings: string[] = [];
    for (const id of body.nurseIds) {
      const nurse = assertStaffAvailable(db, id, ['NURSE'], start);
      const w = genderCheck(db, ep.patient_id, nurse);
      if (w) warnings.push(w);
    }

    const planned = buildRoster({ start, days: body.days ?? plan.duration_days, shiftHours: plan.shift_hours, hoursPerDay: plan.hours_per_day, nurseIds: body.nurseIds });
    for (const nurseId of new Set(body.nurseIds)) {
      assertWorkingTime(db, nurseId, planned.filter((s) => s.nurseId === nurseId), { by: staff, reason: body.overrideReason });
    }
    const ids = db.tx(() => planned.map((s) => {
      const overlap = db.get(
        `SELECT id FROM shifts WHERE nurse_id = ? AND status IN ('PLANNED','LATE','CHECKED_IN') AND planned_start < ? AND planned_end > ?`,
        s.nurseId, s.end.toISOString(), s.start.toISOString(),
      );
      if (overlap) throw new HttpError(409, `Nurse ${s.nurseId} already has shift ${overlap.id} at ${s.start.toISOString()}`);
      return db.insert('shifts', { episode_id: ep.id, nurse_id: s.nurseId, planned_start: s.start, planned_end: s.end });
    }));
    for (const id of new Set(body.nurseIds)) notify(db, `staff:${id}`, 'PUSH', `Roster published for ${ep.episode_no}`);
    audit(db, staff.id, 'PUBLISH_ROSTER', 'episodes', ep.id, { shifts: ids.length });
    res.status(201).json({ shifts: ids.length, ids, warnings });
  }));

  r.get('/shifts', wrap((req) => {
    requireStaff(db, req);
    const nurseId = Number(req.query.nurseId);
    return db.all(
      `SELECT s.*, e.episode_no, p.full_name, p.address FROM shifts s JOIN episodes e ON e.id = s.episode_id JOIN patients p ON p.id = e.patient_id
       WHERE (? = 0 OR s.nurse_id = ?) ORDER BY s.planned_start LIMIT 500`,
      nurseId || 0, nurseId || 0,
    );
  }));

  // Coordinator board / scheduler: flag shifts with no check-in after the grace period.
  r.post('/shifts/check-late', wrap((req) => {
    requireRole(db, req, 'COORDINATOR', 'SUPERVISOR');
    return { late: checkLateShifts(db, now(req)) };
  }));

  // Send a backup nurse for a late / missed shift.
  r.post('/shifts/:id/reassign', wrap((req) => {
    const staff = requireRole(db, req, 'COORDINATOR', 'SUPERVISOR');
    const { nurseId, overrideReason } = z.object({ nurseId: z.number().int(), overrideReason: z.string().min(5).optional() }).parse(req.body);
    const shift = getOr404(db, 'shifts', req.params.id, 'Shift');
    if (!['PLANNED', 'LATE'].includes(shift.status)) throw new HttpError(409, `Shift is ${shift.status}`);
    const backup = assertStaffAvailable(db, nurseId, ['NURSE'], now(req));
    const ep0 = getOr404(db, 'episodes', shift.episode_id, 'Episode');
    const warning = genderCheck(db, ep0.patient_id, backup);
    // A backup nurse coming off a night shift must still get the minimum rest (BR-33).
    assertWorkingTime(db, nurseId, [{ start: new Date(shift.planned_start), end: new Date(shift.planned_end) }], { by: staff, reason: overrideReason });
    return db.tx(() => {
      db.update('shifts', shift.id, { status: 'MISSED' });
      const id = db.insert('shifts', { episode_id: shift.episode_id, nurse_id: nurseId, planned_start: shift.planned_start, planned_end: shift.planned_end, replaced_shift_id: shift.id });
      db.run(`UPDATE escalations SET status = 'RESOLVED', acked_by = ?, closed_at = ? WHERE trigger = 'LATE_SHIFT' AND ref_id = ? AND status != 'RESOLVED'`, staff.id, now(req).toISOString(), shift.id);
      notify(db, `staff:${nurseId}`, 'CALL', `Urgent: cover shift ${id} now`);
      return { newShiftId: id, warnings: warning ? [warning] : [] };
    });
  }));

  r.post('/shifts/:id/check-in', wrap((req) => {
    const body = z.object({ lat: z.number(), lng: z.number(), consent: ConsentInput.optional() }).parse(req.body);
    const { shift, staff } = nurseShift(db, req);
    if (!['PLANNED', 'LATE'].includes(shift.status)) throw new HttpError(409, `Shift is ${shift.status}`);
    const ep = getOr404(db, 'episodes', shift.episode_id);
    if (ep.status !== 'ACTIVE') throw new HttpError(409, `Care is ${ep.status === 'ON_HOLD' ? 'on hold' : ep.status}: check with the coordinator before starting`);
    const p = getOr404(db, 'patients', ep.patient_id);
    if (p.lat !== null) {
      const d = distanceMetres(body, { lat: p.lat, lng: p.lng });
      if (d > cfg().checkInRadiusM) throw new HttpError(400, `You are ${Math.round(d)} m from the patient address`);
    }
    db.tx(() => {
      ensureConsent(db, p, 'NURSE', now(req), staff.id, body.consent); // BR-80
      db.update('shifts', shift.id, { status: 'CHECKED_IN', check_in_at: now(req) });
    });
    return { status: 'CHECKED_IN' };
  }));

  r.post('/shifts/:id/notes', wrap((req, res) => {
    const body = z.object({ type: z.enum(['PROGRESS', 'HANDOVER', 'INCIDENT', 'MEDICATION']).default('PROGRESS'), text: z.string().min(1) }).parse(req.body);
    const { shift } = nurseShift(db, req);
    if (shift.status !== 'CHECKED_IN') throw new HttpError(409, 'Check in before writing notes');
    const id = db.insert('shift_notes', { shift_id: shift.id, type: body.type, text: body.text, at: now(req) });
    if (body.type === 'INCIDENT') openEscalation(db, shift.episode_id, 'INCIDENT', 'REVIEW', 'Supervisor review', now(req), id);
    res.status(201).json({ id });
  }));

  // Vitals with automatic NEWS2 and escalation (BRD §5.5).
  r.post('/shifts/:id/vitals', wrap((req, res) => {
    const v = VitalsInput.parse(req.body);
    const { shift } = nurseShift(db, req);
    if (shift.status !== 'CHECKED_IN') throw new HttpError(409, 'Check in before recording vitals');
    const ep = getOr404(db, 'episodes', shift.episode_id);
    const score = scoreNews2(v);
    const out = db.tx(() => {
      const id = db.insert('vitals', { episode_id: ep.id, shift_id: shift.id, data: v, news2_total: score.total, band: score.band, at: now(req) });
      let escalationId: number | undefined;
      if (needsEscalation(score)) {
        escalationId = openEscalation(db, ep.id, 'NEWS2', score.band, score.action, now(req), id);
        if (score.band === 'HIGH') {
          db.update('episodes', ep.id, { status: 'ON_HOLD', hold_reason: `NEWS2 ${score.total}: emergency` });
          notifyDoctor(db, ep.doctor_id, 'CALL', `NEWS2 ${score.total} for ${ep.episode_no}: ambulance called`);
          notify(db, `patient:${ep.patient_id}`, 'CALL', 'Emergency: family informed, ambulance on the way');
        } else {
          for (const rcpt of escalationRecipients('ONCALL_DOCTOR')) notify(db, rcpt, 'CALL', `NEWS2 ${score.total} (${score.band}) for ${ep.episode_no}`);
        }
      }
      return { id, news2: score, escalationId };
    });
    res.status(201).json(out);
  }));

  // §5.5 timer sweep, run by the scheduler every minute (like /shifts/check-late).
  r.post('/escalations/check-timers', wrap((req) => { requireRole(db, req, 'COORDINATOR', 'SUPERVISOR', 'DOCTOR'); return runEscalationTimers(db, now(req)); }));

  r.post('/escalations/:id/ack', wrap((req) => {
    const staff = requireRole(db, req, 'DOCTOR', 'SUPERVISOR');
    const body = z.object({ decision: z.string().min(2), resolve: z.boolean().default(false) }).parse(req.body);
    const e = getOr404(db, 'escalations', req.params.id, 'Escalation');
    db.update('escalations', e.id, { status: body.resolve ? 'RESOLVED' : 'ACKED', acked_by: staff.id, closed_at: body.resolve ? now(req) : undefined });
    audit(db, staff.id, 'ESCALATION_DECISION', 'escalations', e.id, body.decision);
    return { status: body.resolve ? 'RESOLVED' : 'ACKED' };
  }));

  // Check-out requires a handover note; billable minutes come from actual attendance.
  r.post('/shifts/:id/check-out', wrap((req) => {
    const body = z.object({ handover: z.string().min(5) }).parse(req.body);
    const { shift } = nurseShift(db, req);
    if (shift.status !== 'CHECKED_IN') throw new HttpError(409, `Shift is ${shift.status}`);
    const out = now(req);
    const mins = billableMinutes({ plannedStart: new Date(shift.planned_start), plannedEnd: new Date(shift.planned_end), checkIn: new Date(shift.check_in_at), checkOut: out });
    db.tx(() => {
      db.insert('shift_notes', { shift_id: shift.id, type: 'HANDOVER', text: body.handover, at: out });
      db.update('shifts', shift.id, { status: 'COMPLETED', check_out_at: out, billable_minutes: mins });
    });
    return { status: 'COMPLETED', billableMinutes: mins };
  }));

  r.post('/episodes/:id/discharge', wrap((req) => {
    const staff = requireRole(db, req, 'DOCTOR');
    const { summary } = z.object({ summary: z.string().min(10) }).parse(req.body);
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    if (!['ACTIVE', 'ON_HOLD'].includes(ep.status)) throw new HttpError(409, `Episode is ${ep.status}`);
    const t = now(req);
    return db.tx(() => {
      db.update('episodes', ep.id, { status: 'DISCHARGED', discharged_at: t, discharge_summary: summary });
      db.run(`UPDATE shifts SET status = 'CANCELLED' WHERE episode_id = ? AND status IN ('PLANNED','LATE') AND planned_start > ?`, ep.id, t.toISOString());
      const devices = db.all(`SELECT id FROM rentals WHERE episode_id = ? AND status = 'ACTIVE'`, ep.id);
      if (devices.length) notify(db, 'role:DRIVER', 'PUSH', `${ep.episode_no}: pick up ${devices.length} device(s)`);
      notify(db, `patient:${ep.patient_id}`, 'SMS', 'Thank you. Please rate our service.');
      audit(db, staff.id, 'DISCHARGE', 'episodes', ep.id);
      return { status: 'DISCHARGED', devicesToCollect: devices.length };
    });
  }));

  return r;
}
