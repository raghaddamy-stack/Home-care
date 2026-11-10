// Intake (app + call center), coordinator review, pricing, quote, routing and scheduling.
import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Db, Row } from '../db.js';
import { assertTransition, ROUTES, type RequestStatus, type Route } from '../domain/requestStatus.js';
import { buildQuote, COORDINATOR_DISCOUNT_LIMIT, type Coverage } from '../domain/pricing.js';
import { actor, audit, getOr404, HttpError, notify, now, requireRole, wrap } from '../http.js';

const PatientInput = z.object({
  nationalId: z.string().min(5),
  fullName: z.string().min(2),
  dob: z.string().optional(),
  gender: z.enum(['M', 'F']).optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  zoneId: z.number().int().optional(),
  emergencyContact: z.string().optional(),
});

const CreateRequest = z.object({
  channel: z.enum(['APP', 'CALL_CENTER']),
  patient: PatientInput,
  items: z.array(z.object({ serviceCode: z.string(), qty: z.number().positive().default(1) })).min(1),
  urgency: z.enum(['ROUTINE', 'SAME_DAY', 'URGENT']).default('ROUTINE'),
  preferredAt: z.string().datetime().optional(),
  clinicalNotes: z.string().optional(),
  prescriptionRef: z.string().optional(),
  insurance: z.object({ payerId: z.number().int(), memberNo: z.string() }).optional(),
});

export function setStatus(db: Db, req: Row, to: RequestStatus, actorId?: number, note?: string) {
  assertTransition(req.status, to);
  db.update('service_requests', req.id, { status: to });
  db.insert('request_history', { request_id: req.id, from_status: req.status, to_status: to, actor_id: actorId, note });
  req.status = to;
}

/** Mandatory data before a request can be priced (BR-02). Returns the missing fields. */
export function missingInfo(db: Db, request: Row): string[] {
  const p = getOr404(db, 'patients', request.patient_id, 'Patient');
  const missing: string[] = [];
  for (const [col, label] of [
    ['dob', 'dob'],
    ['gender', 'gender'],
    ['phone', 'phone'],
    ['address', 'address'],
    ['lat', 'gps location'],
    ['emergency_contact', 'emergency contact'],
  ] as const) {
    if (p[col] === null || p[col] === undefined || p[col] === '') missing.push(label);
  }
  const needsRx = db.get(
    `SELECT 1 FROM request_items i JOIN services s ON s.code = i.service_code
     WHERE i.request_id = ? AND s.requires_prescription = 1`,
    request.id,
  );
  if (needsRx && !request.prescription_ref) missing.push('prescription');
  return missing;
}

function upsertPatient(db: Db, p: z.infer<typeof PatientInput>): number {
  const existing = db.get('SELECT * FROM patients WHERE national_id = ?', p.nationalId);
  const cols = {
    full_name: p.fullName,
    dob: p.dob,
    gender: p.gender,
    phone: p.phone,
    address: p.address,
    lat: p.lat,
    lng: p.lng,
    zone_id: p.zoneId,
    emergency_contact: p.emergencyContact,
  };
  if (existing) {
    // Only fill in or correct provided fields; never blank existing data.
    db.update('patients', existing.id, cols);
    return existing.id;
  }
  return db.insert('patients', { national_id: p.nationalId, ...cols });
}

function coverageFor(db: Db, policyId: number | null): { coverage?: Coverage; payerId: number | null } {
  if (!policyId) return { payerId: null };
  const pol = getOr404(db, 'insurance_policies', policyId, 'Policy');
  return {
    payerId: pol.payer_id,
    coverage: { copayPct: pol.copay_pct, copayCap: pol.copay_cap ?? undefined, coveredCodes: JSON.parse(pol.covered_codes) },
  };
}

/** Staff role that may perform each kind of visit. */
const VISIT_ROLES: Record<string, string[]> = {
  ASSESSMENT: ['DOCTOR', 'NURSE'],
  NURSE: ['NURSE'],
  DOCTOR: ['DOCTOR'],
  LAB: ['LAB_TECH', 'NURSE'],
  IMAGING: ['RADIOGRAPHER'],
  DEVICE: ['DRIVER'],
};

function visitKindFor(db: Db, requestId: number, route: Route): string {
  if (route !== 'DIRECT') return route;
  const line = db.get<{ line: string }>(
    `SELECT s.line FROM request_items i JOIN services s ON s.code = i.service_code WHERE i.request_id = ? LIMIT 1`,
    requestId,
  )!.line;
  return ({ LAB: 'LAB', IMG: 'IMAGING', DEV: 'DEVICE', DOC: 'DOCTOR', NRS: 'NURSE' } as Record<string, string>)[line];
}

export function assertStaffAvailable(db: Db, staffId: number, roles: string[], at: Date): Row {
  const s = getOr404(db, 'staff', staffId, 'Staff');
  if (!s.active) throw new HttpError(409, 'Staff member is inactive');
  if (!roles.includes(s.role)) throw new HttpError(409, `Staff role ${s.role} cannot do this (needs ${roles.join('/')})`);
  if (s.licence_expiry && new Date(s.licence_expiry) < at) throw new HttpError(409, 'Staff licence expired (BR-36)');
  return s;
}

export function requestRoutes(db: Db): Router {
  const r = Router();

  r.post('/', wrap((req, res) => {
    const body = CreateRequest.parse(req.body);
    const staff = actor(db, req);
    if (body.channel === 'CALL_CENTER' && !staff) throw new HttpError(401, 'Call-center requests need x-staff-id');

    const out = db.tx(() => {
      for (const it of body.items) {
        if (!db.get('SELECT 1 FROM services WHERE code = ?', it.serviceCode)) throw new HttpError(400, `Unknown service ${it.serviceCode}`);
      }
      const patientId = upsertPatient(db, body.patient);
      let policyId: number | undefined;
      if (body.insurance) {
        const pol = db.get('SELECT id FROM insurance_policies WHERE patient_id = ? AND payer_id = ? AND member_no = ?', patientId, body.insurance.payerId, body.insurance.memberNo);
        policyId = pol?.id ?? db.insert('insurance_policies', { patient_id: patientId, payer_id: body.insurance.payerId, member_no: body.insurance.memberNo });
      }
      const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM service_requests')!.n;
      const id = db.insert('service_requests', {
        request_no: `REQ-${String(count + 1).padStart(6, '0')}`,
        patient_id: patientId,
        channel: body.channel,
        created_by: staff?.id,
        status: 'SUBMITTED',
        urgency: body.urgency,
        preferred_at: body.preferredAt,
        clinical_notes: body.clinicalNotes,
        prescription_ref: body.prescriptionRef,
        policy_id: policyId,
      });
      db.insert('request_history', { request_id: id, to_status: 'SUBMITTED', actor_id: staff?.id, note: body.channel });
      for (const it of body.items) db.insert('request_items', { request_id: id, service_code: it.serviceCode, qty: it.qty });

      const request = getOr404(db, 'service_requests', id);
      const missing = missingInfo(db, request);
      if (missing.length) {
        setStatus(db, request, 'PENDING_INFO', staff?.id, `Missing: ${missing.join(', ')}`);
        notify(db, `role:AGENT`, 'PUSH', `${request.request_no}: call patient to complete ${missing.join(', ')}`);
      } else {
        setStatus(db, request, 'UNDER_REVIEW', staff?.id);
        notify(db, 'role:COORDINATOR', 'PUSH', `New request ${request.request_no} to review`);
      }
      return { ...request, missing };
    });
    res.status(201).json(out);
  }));

  r.get('/', wrap((req) => {
    const status = req.query.status as string | undefined;
    return status
      ? db.all('SELECT * FROM service_requests WHERE status = ? ORDER BY id DESC', status)
      : db.all('SELECT * FROM service_requests ORDER BY id DESC LIMIT 200');
  }));

  r.get('/:id', wrap((req) => {
    const request = getOr404(db, 'service_requests', req.params.id, 'Request');
    return {
      ...request,
      patient: db.get('SELECT * FROM patients WHERE id = ?', request.patient_id),
      items: db.all('SELECT * FROM request_items WHERE request_id = ?', request.id),
      quotes: db.all('SELECT * FROM quotes WHERE request_id = ? ORDER BY version', request.id).map((q) => ({ ...q, lines: JSON.parse(q.lines) })),
      visits: db.all('SELECT * FROM visits WHERE request_id = ?', request.id),
      history: db.all('SELECT * FROM request_history WHERE request_id = ? ORDER BY id', request.id),
    };
  }));

  // Call center fills in missing data, then the request returns to review.
  r.post('/:id/complete-info', wrap((req) => {
    const staff = requireRole(db, req, 'AGENT', 'COORDINATOR');
    const body = PatientInput.partial().extend({ prescriptionRef: z.string().optional() }).parse(req.body);
    const request = getOr404(db, 'service_requests', req.params.id, 'Request');
    return db.tx(() => {
      const p = getOr404(db, 'patients', request.patient_id);
      upsertPatient(db, { ...body, nationalId: p.national_id, fullName: body.fullName ?? p.full_name });
      if (body.prescriptionRef) db.update('service_requests', request.id, { prescription_ref: body.prescriptionRef });
      const missing = missingInfo(db, { ...request, prescription_ref: body.prescriptionRef ?? request.prescription_ref });
      if (missing.length === 0) setStatus(db, request, 'UNDER_REVIEW', staff.id, 'Data completed');
      return { status: request.status, missing };
    });
  }));

  // Coordinator prices the request and sends the quote (or parks it for insurer pre-approval).
  r.post('/:id/quote', wrap((req) => {
    const staff = requireRole(db, req, 'COORDINATOR');
    const body = z.object({
      discountPct: z.number().min(0).max(100).default(0),
      approvedBy: z.number().int().optional(),
      preApprovalNo: z.string().optional(),
      scheduledAt: z.string().datetime().optional(),
    }).parse(req.body);
    const request = getOr404(db, 'service_requests', req.params.id, 'Request');

    if (body.discountPct > COORDINATOR_DISCOUNT_LIMIT) {
      const approver = body.approvedBy ? db.get('SELECT * FROM staff WHERE id = ?', body.approvedBy) : undefined;
      if (!approver || !['SUPERVISOR', 'ADMIN'].includes(approver.role)) {
        throw new HttpError(403, `Discount above ${COORDINATOR_DISCOUNT_LIMIT}% needs a supervisor approval (BR-11)`);
      }
    }

    return db.tx(() => {
      const items = db.all('SELECT i.*, s.requires_preapproval FROM request_items i JOIN services s ON s.code = i.service_code WHERE request_id = ?', request.id);
      const { coverage, payerId } = coverageFor(db, request.policy_id);
      if (coverage && !body.preApprovalNo && items.some((i) => i.requires_preapproval && coverage.coveredCodes.includes(i.service_code))) {
        if (request.status !== 'PENDING_PREAPPROVAL') setStatus(db, request, 'PENDING_PREAPPROVAL', staff.id, 'Sent to insurer');
        return { status: request.status, message: 'Waiting for insurer pre-approval. Call again with preApprovalNo.' };
      }

      const codes = items.map((i) => i.service_code);
      const priceRows = db.all(
        `SELECT service_code, unit_price, payer_id FROM price_items
         WHERE service_code IN (${codes.map(() => '?').join(',')}) AND (payer_id IS NULL OR payer_id = ?)`,
        ...codes, payerId,
      );
      // Payer list wins over the cash list (BR-10).
      const prices = codes.map((c) => {
        const row = priceRows.find((p) => p.service_code === c && p.payer_id === payerId) ?? priceRows.find((p) => p.service_code === c && p.payer_id === null);
        if (!row) throw new HttpError(409, `No price for ${c}`);
        return { serviceCode: c, unitPrice: row.unit_price };
      });
      const when = body.scheduledAt ?? request.preferred_at;
      const quote = buildQuote(items.map((i) => ({ serviceCode: i.service_code, qty: i.qty })), prices, {
        discountPct: body.discountPct,
        scheduledAt: when ? new Date(when) : undefined,
        coverage,
      });

      setStatus(db, request, 'QUOTED', staff.id, body.preApprovalNo ? `Pre-approval ${body.preApprovalNo}` : undefined);
      db.run(`UPDATE quotes SET status = 'SUPERSEDED' WHERE request_id = ? AND status = 'SENT'`, request.id);
      const version = (db.get<{ v: number }>('SELECT COALESCE(MAX(version),0) AS v FROM quotes WHERE request_id = ?', request.id)!.v) + 1;
      const quoteId = db.insert('quotes', {
        request_id: request.id, version, lines: quote.lines, discount_pct: body.discountPct,
        total: quote.total, payer_total: quote.payerTotal, patient_total: quote.patientTotal,
      });
      db.update('service_requests', request.id, { coordinator_id: staff.id });
      notify(db, `patient:${request.patient_id}`, 'SMS', `Quote for ${request.request_no}: you pay ${(quote.patientTotal / 1000).toFixed(3)} JOD`);
      audit(db, staff.id, 'QUOTE', 'service_requests', request.id, { version, discount: body.discountPct });
      return { id: quoteId, version, ...quote };
    });
  }));

  r.post('/:id/accept', wrap((req) => {
    const request = getOr404(db, 'service_requests', req.params.id, 'Request');
    return db.tx(() => {
      setStatus(db, request, 'ACCEPTED', actor(db, req)?.id, req.body?.evidence ?? 'app');
      db.run(`UPDATE quotes SET status = 'ACCEPTED', accepted_at = ? WHERE request_id = ? AND status = 'SENT'`, now(req).toISOString(), request.id);
      notify(db, 'role:COORDINATOR', 'PUSH', `${request.request_no} accepted: schedule it`);
      return { status: request.status };
    });
  }));

  r.post('/:id/cancel', wrap((req) => {
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    const request = getOr404(db, 'service_requests', req.params.id, 'Request');
    return db.tx(() => {
      setStatus(db, request, 'CANCELLED', actor(db, req)?.id, reason);
      db.update('service_requests', request.id, { cancel_reason: reason });
      db.run(`UPDATE quotes SET status = 'REJECTED' WHERE request_id = ? AND status = 'SENT'`, request.id);
      db.run(`UPDATE visits SET status = 'CANCELLED' WHERE request_id = ? AND status = 'SCHEDULED'`, request.id);
      return { status: request.status };
    });
  }));

  // Coordinator routes the request and assigns staff (BPMN gateway "توجيه الطلب").
  r.post('/:id/schedule', wrap((req) => {
    const staff = requireRole(db, req, 'COORDINATOR');
    const body = z.object({ route: z.enum(ROUTES), staffId: z.number().int(), scheduledAt: z.string().datetime() }).parse(req.body);
    const request = getOr404(db, 'service_requests', req.params.id, 'Request');
    return db.tx(() => {
      const kind = visitKindFor(db, request.id, body.route);
      const at = new Date(body.scheduledAt);
      const assignee = assertStaffAvailable(db, body.staffId, VISIT_ROLES[kind], at);
      const clash = db.get(
        `SELECT id FROM visits WHERE staff_id = ? AND status IN ('SCHEDULED','DISPATCHED','CHECKED_IN')
         AND abs(julianday(scheduled_at) - julianday(?)) * 24 < 1`,
        assignee.id, at.toISOString(),
      );
      if (clash) throw new HttpError(409, 'Staff already has a visit within an hour of that time. Propose another slot.');

      setStatus(db, request, 'SCHEDULED', staff.id, `${body.route} → ${assignee.name}`);
      db.update('service_requests', request.id, { route: body.route });
      const otp = String(randomInt(1000, 10000));
      const visitId = db.insert('visits', { request_id: request.id, staff_id: assignee.id, kind, scheduled_at: at, otp });
      notify(db, `staff:${assignee.id}`, 'PUSH', `New ${kind} visit ${request.request_no} at ${at.toISOString()}`);
      notify(db, `patient:${request.patient_id}`, 'SMS', `Booked: ${assignee.name} at ${at.toISOString()}. Visit code ${otp}`);
      return { visitId, kind, status: request.status };
    });
  }));

  return r;
}
