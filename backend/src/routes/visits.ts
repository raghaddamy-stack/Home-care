// Dispatch, check-in, no-show and completion of direct (outpatient) services.
import { Router } from 'express';
import { z } from 'zod';
import type { Db, Row } from '../db.js';
import { CHECK_IN_RADIUS_M, distanceMetres } from '../domain/shifts.js';
import { buildInvoiceLines } from '../domain/billing.js';
import { audit, getOr404, HttpError, notify, now, requireRole, wrap } from '../http.js';
import { setStatus } from './requests.js';

/** No-show fee: 50% of the visit price, minimum 10 JOD (BR-24). */
export const NO_SHOW_MIN_FEE = 10_000;

const FIELD_ROLES = ['DOCTOR', 'NURSE', 'LAB_TECH', 'RADIOGRAPHER', 'DRIVER'];

function nextInvoiceNo(db: Db): string {
  const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invoices')!.n + 1;
  return `INV-${String(n).padStart(6, '0')}`;
}

export function createInvoice(
  db: Db,
  head: { patient_id: number; kind: 'VISIT' | 'PERIODIC' | 'FINAL'; episode_id?: number; request_id?: number; period_from?: Date; period_to?: Date },
  lines: ReturnType<typeof buildInvoiceLines>,
): number {
  const sum = (k: 'amount' | 'payerAmount' | 'patientAmount') => lines.reduce((a, l) => a + l[k], 0);
  const id = db.insert('invoices', {
    invoice_no: nextInvoiceNo(db), ...head,
    total: sum('amount'), payer_total: sum('payerAmount'), patient_total: sum('patientAmount'),
  });
  for (const l of lines) {
    db.insert('invoice_lines', {
      invoice_id: id, source_type: l.sourceType, source_id: l.sourceId, description: l.description,
      qty: l.qty, unit_price: l.unitPrice, amount: l.amount, payer_amount: l.payerAmount, patient_amount: l.patientAmount,
    });
  }
  return id;
}

function ownVisit(db: Db, req: any): { visit: Row; staff: Row; request: Row } {
  const staff = requireRole(db, req, ...FIELD_ROLES, 'COORDINATOR');
  const visit = getOr404(db, 'visits', req.params.id, 'Visit');
  if (staff.role !== 'COORDINATOR' && staff.role !== 'ADMIN' && visit.staff_id !== staff.id) {
    throw new HttpError(403, 'Visit is assigned to someone else');
  }
  const request = getOr404(db, 'service_requests', visit.request_id, 'Request');
  return { visit, staff, request };
}

export function visitRoutes(db: Db): Router {
  const r = Router();

  r.get('/', wrap((req) => {
    const staffId = Number(req.query.staffId);
    return staffId
      ? db.all(`SELECT v.*, r.request_no, p.full_name, p.address, p.lat, p.lng FROM visits v
                JOIN service_requests r ON r.id = v.request_id JOIN patients p ON p.id = r.patient_id
                WHERE v.staff_id = ? ORDER BY v.scheduled_at`, staffId)
      : db.all('SELECT * FROM visits ORDER BY scheduled_at DESC LIMIT 200');
  }));

  // Logistics unit sends staff / sample kit / device on the way.
  r.post('/:id/dispatch', wrap((req) => {
    const { visit, staff, request } = ownVisit(db, req);
    return db.tx(() => {
      db.update('visits', visit.id, { status: 'DISPATCHED' });
      setStatus(db, request, 'DISPATCHED', staff.id);
      notify(db, `patient:${request.patient_id}`, 'SMS', `${request.request_no}: our team is on the way`);
      return { status: 'DISPATCHED' };
    });
  }));

  // Check-in by GPS (within 150 m) or by the patient's visit code (BR-26).
  r.post('/:id/check-in', wrap((req) => {
    const body = z.object({ otp: z.string().optional(), lat: z.number().optional(), lng: z.number().optional() }).parse(req.body);
    const { visit, staff, request } = ownVisit(db, req);
    if (visit.status !== 'DISPATCHED') throw new HttpError(409, `Visit is ${visit.status}, dispatch it first`);
    const patient = getOr404(db, 'patients', request.patient_id);
    let method: string;
    if (body.otp) {
      if (body.otp !== visit.otp) throw new HttpError(400, 'Wrong visit code');
      method = 'OTP';
    } else if (body.lat !== undefined && body.lng !== undefined && patient.lat !== null) {
      const d = distanceMetres({ lat: body.lat, lng: body.lng }, { lat: patient.lat, lng: patient.lng });
      if (d > CHECK_IN_RADIUS_M) throw new HttpError(400, `You are ${Math.round(d)} m from the patient address`);
      method = 'GPS';
    } else throw new HttpError(400, 'Send the visit code or GPS position');
    return db.tx(() => {
      db.update('visits', visit.id, { status: 'CHECKED_IN', check_in_at: now(req), check_in_method: method });
      setStatus(db, request, 'IN_PROGRESS', staff.id, `Check-in ${method}`);
      return { status: 'CHECKED_IN', method };
    });
  }));

  // Patient not home: record no-show, charge the fee, request goes back for rescheduling.
  r.post('/:id/no-show', wrap((req) => {
    const { visit, staff, request } = ownVisit(db, req);
    return db.tx(() => {
      db.update('visits', visit.id, { status: 'NO_SHOW' });
      setStatus(db, request, 'NO_SHOW', staff.id);
      const quote = db.get(`SELECT * FROM quotes WHERE request_id = ? AND status = 'ACCEPTED'`, request.id);
      const fee = Math.max(NO_SHOW_MIN_FEE, Math.round((quote?.patient_total ?? 0) / 2));
      const invoiceId = createInvoice(db, { patient_id: request.patient_id, kind: 'VISIT', request_id: request.id }, buildInvoiceLines(
        [{ sourceType: 'VISIT', sourceId: visit.id, description: 'No-show fee', qty: 1, unitPrice: fee }], null));
      notify(db, 'role:COORDINATOR', 'PUSH', `${request.request_no}: patient no-show, reschedule`);
      return { status: 'NO_SHOW', invoiceId, fee };
    });
  }));

  // Direct service done: result / device handover, invoice from the accepted quote, payment.
  r.post('/:id/complete', wrap((req) => {
    const body = z.object({
      result: z.object({ report: z.string(), critical: z.boolean().default(false) }).optional(),
      rental: z.object({ serialNo: z.string(), expectedReturn: z.string(), handoverSigned: z.literal(true), deposit: z.number().int().default(0) }).optional(),
      payment: z.object({ method: z.enum(['CASH', 'CARD', 'LINK', 'TRANSFER', 'CLIQ']), amount: z.number().int().positive(), reference: z.string().optional() }).optional(),
    }).parse(req.body);
    const { visit, staff, request } = ownVisit(db, req);
    if (visit.status !== 'CHECKED_IN') throw new HttpError(409, 'Check in first');
    if (request.route !== 'DIRECT') throw new HttpError(409, 'Assessment and nursing visits are completed by opening an episode');
    const at = now(req);

    return db.tx(() => {
      const items = db.all('SELECT i.*, s.department, s.line, s.name_en FROM request_items i JOIN services s ON s.code = i.service_code WHERE request_id = ?', request.id);
      const out: Record<string, unknown> = {};
      for (const it of items) {
        if (it.line === 'LAB' || it.line === 'IMG') {
          const orderId = db.insert('orders', { request_id: request.id, service_code: it.service_code, department: it.department, ordered_by: staff.id, status: body.result ? 'VALIDATED' : 'IN_PROGRESS' });
          if (body.result) {
            const resultId = db.insert('results', { order_id: orderId, patient_id: request.patient_id, report: body.result.report, critical: body.result.critical, validated_by: staff.id, released_at: body.result.critical ? undefined : at });
            out.resultId = resultId;
            if (body.result.critical) notify(db, 'role:DOCTOR', 'CALL', `CRITICAL result for ${request.request_no}: acknowledge result ${resultId}`);
            else notify(db, `patient:${request.patient_id}`, 'PUSH', `Your ${it.name_en} result is ready`);
          }
        }
        if (it.line === 'DEV') {
          if (!body.rental) throw new HttpError(400, 'Device handover needs rental details and a signed handover form');
          const price = db.get(`SELECT unit_price FROM price_items WHERE service_code = ? AND payer_id IS NULL`, it.service_code);
          out.rentalId = db.insert('rentals', {
            patient_id: request.patient_id, request_id: request.id, service_code: it.service_code, serial_no: body.rental.serialNo,
            start_date: at, expected_return: body.rental.expectedReturn, daily_rate: price?.unit_price ?? 0, deposit: body.rental.deposit,
          });
        }
      }

      const quote = db.get(`SELECT * FROM quotes WHERE request_id = ? AND status = 'ACCEPTED'`, request.id);
      if (!quote) throw new HttpError(409, 'No accepted quote');
      const lines = (JSON.parse(quote.lines) as any[]).map((l) => ({
        sourceType: 'VISIT' as const, sourceId: visit.id, description: l.serviceCode, qty: l.qty, unitPrice: Math.round(l.net / l.qty),
        amount: l.net, payerAmount: l.payerShare, patientAmount: l.patientShare,
      }));
      const invoiceId = createInvoice(db, { patient_id: request.patient_id, kind: 'VISIT', request_id: request.id }, lines);
      db.update('invoices', invoiceId, { status: 'ISSUED' });
      if (body.payment) {
        db.insert('payments', { invoice_id: invoiceId, method: body.payment.method, amount: body.payment.amount, reference: body.payment.reference, collected_by: staff.id });
        const paid = body.payment.amount >= quote.patient_total;
        db.update('invoices', invoiceId, { status: paid ? 'PAID' : 'PARTIALLY_PAID' });
      }

      db.update('visits', visit.id, { status: 'COMPLETED', completed_at: at });
      setStatus(db, request, 'COMPLETED', staff.id);
      audit(db, staff.id, 'COMPLETE_VISIT', 'visits', visit.id);
      return { status: 'COMPLETED', invoiceId, ...out };
    });
  }));

  return r;
}
