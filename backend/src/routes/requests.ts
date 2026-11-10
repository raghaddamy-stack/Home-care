// Intake (app + call center), coordinator review, pricing, quote, routing and scheduling.
import { Router } from 'express';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Db, Row } from '../db.js';
import { assertTransition, ROUTES, type RequestStatus, type Route } from '../domain/requestStatus.js';
import { buildQuote, isQuoteExpired, quoteValidUntil, type Coverage, type Urgency } from '../domain/pricing.js';
import { cancellationFee, prepaymentRequired } from '../domain/patientPolicy.js';
import { cfg } from '../settings.js';
import { buildInvoiceLines } from '../domain/billing.js';
import { audit, getOr404, HttpError, notify, now, requireRole, wrap } from '../http.js';
import { createInvoice } from './visits.js';

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
  preferredStaffGender: z.enum(['M', 'F']).nullable().optional(),
});

export const CreateRequest = z.object({
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
    preferred_staff_gender: p.preferredStaffGender,
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

/**
 * Patient preference for the staff member's gender. Owner setting `genderMatch`: OFF ignores it,
 * WARN returns a warning the coordinator sees, BLOCK refuses the assignment.
 */
export function genderCheck(db: Db, patientId: number, staff: Row): string | null {
  const mode = cfg().genderMatch;
  if (mode === 'OFF') return null;
  const pref = db.get<{ g: string | null }>('SELECT preferred_staff_gender AS g FROM patients WHERE id = ?', patientId)?.g;
  if (!pref || !staff.gender || pref === staff.gender) return null;
  const msg = `Patient prefers ${pref === 'F' ? 'female' : 'male'} staff; ${staff.name} does not match`;
  if (mode === 'BLOCK') throw new HttpError(409, msg);
  return msg;
}

export function assertStaffAvailable(db: Db, staffId: number, roles: string[], at: Date): Row {
  const s = getOr404(db, 'staff', staffId, 'Staff');
  if (!s.active) throw new HttpError(409, 'Staff member is inactive');
  if (!roles.includes(s.role)) throw new HttpError(409, `Staff role ${s.role} cannot do this (needs ${roles.join('/')})`);
  if (s.licence_expiry && new Date(s.licence_expiry) < at) throw new HttpError(409, 'Staff licence expired (BR-36)');
  return s;
}

/** The quote the patient can accept right now (latest SENT version). */
function openQuote(db: Db, requestId: number): Row | undefined {
  return db.get(`SELECT * FROM quotes WHERE request_id = ? AND status = 'SENT' ORDER BY version DESC LIMIT 1`, requestId);
}

/**
 * Record the patient's acceptance (app click, or phone with evidence: BR-13).
 * BR-12: an expired quote cannot be accepted; the request moves to EXPIRED and must be re-priced.
 */
export function acceptQuote(db: Db, request: Row, at: Date, actorId: number | undefined, evidence: string): { status: string } {
  if (request.status !== 'QUOTED') throw new HttpError(409, `Request is ${request.status}, there is no quote to accept`);
  const quote = openQuote(db, request.id);
  if (!quote) throw new HttpError(409, 'No open quote');
  if (isQuoteExpired(quote.valid_until, at)) {
    // Saved outside a transaction so the board shows EXPIRED even though the acceptance is refused.
    setStatus(db, request, 'EXPIRED', actorId, `Quote v${quote.version} expired ${quote.valid_until}`);
    notify(db, 'role:COORDINATOR', 'PUSH', `${request.request_no}: quote expired before acceptance, re-price it`);
    throw new HttpError(409, 'The quote has expired (BR-12). The coordinator will send an updated price.');
  }
  return db.tx(() => {
    setStatus(db, request, 'ACCEPTED', actorId, evidence);
    db.update('quotes', quote.id, { status: 'ACCEPTED', accepted_at: at });
    return { status: request.status };
  });
}

/** BR-12 sweep: QUOTED requests whose open quote passed its validity move to EXPIRED. */
export function expireQuotes(db: Db, at: Date): number[] {
  const rows = db.all(
    `SELECT r.*, q.valid_until, q.version FROM service_requests r JOIN quotes q ON q.request_id = r.id AND q.status = 'SENT'
     WHERE r.status = 'QUOTED' AND q.valid_until IS NOT NULL AND q.valid_until < ?`,
    at.toISOString(),
  );
  return db.tx(() => rows.map((r) => {
    setStatus(db, r, 'EXPIRED', undefined, `Quote v${r.version} expired ${r.valid_until}`);
    notify(db, `patient:${r.patient_id}`, 'SMS', `${r.request_no}: your price offer expired. We will send an updated one if you still need the service.`);
    return r.id as number;
  }));
}

/** The booked visit a cancellation would hit (booked or team on the way). */
function activeVisit(db: Db, requestId: number): Row | undefined {
  return db.get(`SELECT * FROM visits WHERE request_id = ? AND status IN ('SCHEDULED','DISPATCHED') ORDER BY id DESC LIMIT 1`, requestId);
}

/** Visit fee used by BR-23 / BR-24: the patient's share or the full price of the accepted quote (owner setting). */
export function visitFee(db: Db, requestId: number): number {
  const q = db.get<{ p: number; t: number }>(`SELECT patient_total AS p, total AS t FROM quotes WHERE request_id = ? AND status = 'ACCEPTED' ORDER BY version DESC LIMIT 1`, requestId);
  if (!q) return 0;
  return cfg().feeBase === 'FULL_PRICE' ? q.t : q.p;
}

export function cancellationQuote(db: Db, request: Row, at: Date, initiatedBy: 'PATIENT' | 'COMPANY') {
  const v = activeVisit(db, request.id);
  const fee = cancellationFee({
    visitFee: visitFee(db, request.id), scheduledAt: v ? new Date(v.scheduled_at) : null, cancelAt: at, initiatedBy, dispatched: v?.status === 'DISPATCHED',
  });
  return { visitId: v?.id as number | undefined, staffId: v?.staff_id as number | undefined, pct: fee.pct, fee: fee.fee, reason: fee.reason };
}

/** Cancel with a reason. BR-23: a late patient cancellation puts the fee on a draft invoice. */
export function cancelRequest(db: Db, request: Row, opts: { reason: string; initiatedBy: 'PATIENT' | 'COMPANY'; at: Date; actorId?: number }) {
  return db.tx(() => {
    const fee = cancellationQuote(db, request, opts.at, opts.initiatedBy);
    setStatus(db, request, 'CANCELLED', opts.actorId, `${opts.initiatedBy === 'PATIENT' ? 'Patient' : 'Company'}: ${opts.reason}`);
    db.update('service_requests', request.id, { cancel_reason: opts.reason });
    db.run(`UPDATE quotes SET status = 'REJECTED' WHERE request_id = ? AND status = 'SENT'`, request.id);
    let invoiceId: number | undefined;
    if (fee.visitId) {
      db.update('visits', fee.visitId, { status: 'CANCELLED', cancelled_at: opts.at, cancel_fee: fee.fee });
      notify(db, `staff:${fee.staffId}`, 'PUSH', `${request.request_no} cancelled: ${opts.reason}`);
      if (fee.fee > 0) {
        invoiceId = createInvoice(db, { patient_id: request.patient_id, kind: 'VISIT', request_id: request.id }, buildInvoiceLines(
          [{ sourceType: 'VISIT', sourceId: fee.visitId, description: `Cancellation fee ${fee.pct}% (${fee.reason})`, qty: 1, unitPrice: fee.fee }], null));
      }
    }
    audit(db, opts.actorId, 'CANCEL', 'service_requests', request.id, { initiatedBy: opts.initiatedBy, fee: fee.fee, pct: fee.pct });
    return { status: request.status, fee: fee.fee, feePct: fee.pct, feeReason: fee.reason, invoiceId };
  });
}

/** BR-24: scheduled times of the patient's missed visits. */
export function noShowDates(db: Db, patientId: number): Date[] {
  return db.all<{ at: string }>(
    `SELECT v.scheduled_at AS at FROM visits v JOIN service_requests r ON r.id = v.request_id WHERE r.patient_id = ? AND v.status = 'NO_SHOW'`,
    patientId,
  ).map((x) => new Date(x.at));
}

/** BR-24 prepayment position of a request: whether it is required, the amount due and what was collected. */
export function prepaymentStatus(db: Db, request: Row, at: Date, route?: string) {
  const noShows = prepaymentRequired(noShowDates(db, request.patient_id), at);
  // Owner setting: cash direct services (lab / imaging / device) are paid before the visit is booked.
  // Before the coordinator routes it, a request made only of lab / imaging / device items is a direct service.
  const onlyDirectItems = !db.get(`SELECT 1 FROM request_items i JOIN services s ON s.code = i.service_code WHERE i.request_id = ? AND s.line NOT IN ('LAB','IMG','DEV')`, request.id);
  const effectiveRoute = route ?? request.route ?? (onlyDirectItems ? 'DIRECT' : null);
  const beforeBooking = cfg().directServicePayment === 'BEFORE_BOOKING' && !request.policy_id && effectiveRoute === 'DIRECT';
  const required = noShows || beforeBooking;
  const due = visitFee(db, request.id);
  const paid = db.get<{ s: number | null }>('SELECT SUM(amount) AS s FROM prepayments WHERE request_id = ?', request.id)!.s ?? 0;
  return { required, reason: noShows ? 'NO_SHOW' : beforeBooking ? 'PAY_BEFORE_BOOKING' : null, due, paid, outstanding: required ? Math.max(0, due - paid) : 0 };
}

/** Shared by call-center intake and the patient app: find/create the patient file, then the request. */
export function createServiceRequest(db: Db, body: z.infer<typeof CreateRequest>, staffId?: number) {
  const staff = staffId ? { id: staffId } : undefined;
  return db.tx(() => {
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
}

export function requestRoutes(db: Db): Router {
  const r = Router();

  // Staff-entered requests (call center). Patients book through /api/me/requests.
  r.post('/', wrap((req, res) => {
    const staff = requireRole(db, req, 'AGENT', 'COORDINATOR');
    const body = CreateRequest.parse(req.body);
    res.status(201).json(createServiceRequest(db, body, staff.id));
  }));

  r.get('/', wrap((req) => {
    // ?status=A,B filters; each row carries the patient name and the requested services for the boards.
    const statuses = (req.query.status as string | undefined)?.split(',').filter(Boolean) ?? [];
    const where = statuses.length ? `WHERE r.status IN (${statuses.map(() => '?').join(',')})` : '';
    return db.all(
      `SELECT r.*, p.full_name, p.phone, p.national_id,
         (SELECT group_concat(i.service_code, ', ') FROM request_items i WHERE i.request_id = r.id) AS services,
         (SELECT q.patient_total FROM quotes q WHERE q.request_id = r.id AND q.status IN ('SENT','ACCEPTED') ORDER BY q.version DESC LIMIT 1) AS patient_total,
         (SELECT q.total FROM quotes q WHERE q.request_id = r.id AND q.status IN ('SENT','ACCEPTED') ORDER BY q.version DESC LIMIT 1) AS quote_total,
         (SELECT note FROM request_history h WHERE h.request_id = r.id ORDER BY h.id DESC LIMIT 1) AS last_note
       FROM service_requests r JOIN patients p ON p.id = r.patient_id ${where}
       ORDER BY CASE r.urgency WHEN 'URGENT' THEN 0 WHEN 'SAME_DAY' THEN 1 ELSE 2 END, r.id DESC LIMIT 300`,
      ...statuses,
    );
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
      prepayment: prepaymentStatus(db, request, now(req)),
      prepayments: db.all('SELECT * FROM prepayments WHERE request_id = ? ORDER BY id', request.id),
      // What a patient cancellation would cost right now (BR-23), so the agent can tell the patient first.
      cancellation: cancellationQuote(db, request, now(req), 'PATIENT'),
    };
  }));

  // BR-12 sweep, run by the scheduler every few minutes (like /shifts/check-late).
  r.post('/expire-quotes', wrap((req) => ({ expired: expireQuotes(db, now(req)) })));

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

    if (body.discountPct > cfg().coordinatorDiscountLimit) {
      const approver = body.approvedBy ? db.get('SELECT * FROM staff WHERE id = ?', body.approvedBy) : undefined;
      if (!approver || !['SUPERVISOR', 'ADMIN'].includes(approver.role)) {
        throw new HttpError(403, `Discount above ${cfg().coordinatorDiscountLimit}% needs a supervisor approval (BR-11)`);
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

      const validUntil = quoteValidUntil(now(req), request.urgency as Urgency);
      setStatus(db, request, 'QUOTED', staff.id, body.preApprovalNo ? `Pre-approval ${body.preApprovalNo}` : undefined);
      db.run(`UPDATE quotes SET status = 'SUPERSEDED' WHERE request_id = ? AND status = 'SENT'`, request.id);
      const version = (db.get<{ v: number }>('SELECT COALESCE(MAX(version),0) AS v FROM quotes WHERE request_id = ?', request.id)!.v) + 1;
      const quoteId = db.insert('quotes', {
        request_id: request.id, version, lines: quote.lines, discount_pct: body.discountPct,
        total: quote.total, payer_total: quote.payerTotal, patient_total: quote.patientTotal, valid_until: validUntil,
      });
      db.update('service_requests', request.id, { coordinator_id: staff.id });
      notify(db, `patient:${request.patient_id}`, 'SMS', `Quote for ${request.request_no}: you pay ${(quote.patientTotal / 1000).toFixed(3)} JOD, valid until ${validUntil.toISOString().slice(0, 16).replace('T', ' ')}`);
      audit(db, staff.id, 'QUOTE', 'service_requests', request.id, { version, discount: body.discountPct });
      return { id: quoteId, version, validUntil: validUntil.toISOString(), ...quote };
    });
  }));

  // Agent / coordinator records an acceptance given by phone (patients accept in the app via /api/me).
  r.post('/:id/accept', wrap((req) => {
    const staff = requireRole(db, req, 'AGENT', 'COORDINATOR');
    const request = getOr404(db, 'service_requests', req.params.id, 'Request');
    const out = acceptQuote(db, request, now(req), staff.id, req.body?.evidence ?? 'phone');
    notify(db, 'role:COORDINATOR', 'PUSH', `${request.request_no} accepted: schedule it`);
    return out;
  }));

  // initiatedBy COMPANY (no staff, outside the service area, clinical reason) never carries a fee (BR-23/BR-25).
  r.post('/:id/cancel', wrap((req) => {
    const staff = requireRole(db, req, 'AGENT', 'COORDINATOR');
    const body = z.object({ reason: z.string().min(3), initiatedBy: z.enum(['PATIENT', 'COMPANY']).default('PATIENT') }).parse(req.body);
    const request = getOr404(db, 'service_requests', req.params.id, 'Request');
    return cancelRequest(db, request, { reason: body.reason, initiatedBy: body.initiatedBy, at: now(req), actorId: staff.id });
  }));

  // BR-24 / BR-15: money taken before the visit (payment link, CliQ, card by phone).
  r.post('/:id/prepayments', wrap((req, res) => {
    const staff = requireRole(db, req, 'AGENT', 'COORDINATOR', 'FINANCE');
    const body = z.object({ method: z.enum(['CASH', 'CARD', 'LINK', 'TRANSFER', 'CLIQ']), amount: z.number().int().positive(), reference: z.string().optional() }).parse(req.body);
    const request = getOr404(db, 'service_requests', req.params.id, 'Request');
    if (['COMPLETED', 'CANCELLED', 'CONVERTED_TO_EPISODE', 'REFERRED_OUT'].includes(request.status)) throw new HttpError(409, `Request is ${request.status}`);
    const id = db.insert('prepayments', { request_id: request.id, method: body.method, amount: body.amount, reference: body.reference, collected_by: staff.id, at: now(req) });
    audit(db, staff.id, 'PREPAYMENT', 'service_requests', request.id, body);
    res.status(201).json({ id, ...prepaymentStatus(db, request, now(req)) });
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
      const warning = genderCheck(db, request.patient_id, assignee);
      const pre = prepaymentStatus(db, request, now(req), body.route);
      if (pre.outstanding > 0 && pre.reason === 'PAY_BEFORE_BOOKING') {
        throw new HttpError(409, `Cash direct services are paid before booking: collect ${(pre.outstanding / 1000).toFixed(3)} JOD first (owner setting)`);
      }
      if (pre.outstanding > 0) {
        throw new HttpError(409, `Patient has ${cfg().noShowPrepayThreshold} or more no-shows in ${cfg().noShowWindowDays} days: collect a prepayment of ${(pre.outstanding / 1000).toFixed(3)} JOD before booking (BR-24)`);
      }
      // Rescheduling replaces the booked visit instead of leaving two visits open for the same request.
      db.run(`UPDATE visits SET status = 'CANCELLED', cancelled_at = ? WHERE request_id = ? AND status = 'SCHEDULED'`, now(req).toISOString(), request.id);

      setStatus(db, request, 'SCHEDULED', staff.id, `${body.route} → ${assignee.name}`);
      db.update('service_requests', request.id, { route: body.route });
      const otp = String(randomInt(1000, 10000));
      const visitId = db.insert('visits', { request_id: request.id, staff_id: assignee.id, kind, scheduled_at: at, otp });
      notify(db, `staff:${assignee.id}`, 'PUSH', `New ${kind} visit ${request.request_no} at ${at.toISOString()}`);
      notify(db, `patient:${request.patient_id}`, 'SMS', `Booked: ${assignee.name} at ${at.toISOString()}. Visit code ${otp}`);
      return { visitId, kind, status: request.status, warnings: warning ? [warning] : [] };
    });
  }));

  return r;
}
