// Dispatch, check-in, no-show and completion of direct (outpatient) services.
import { Router } from 'express';
import { z } from 'zod';
import { cfg } from '../settings.js';
import type { Db, Row } from '../db.js';
import { distanceMetres } from '../domain/shifts.js';
import { buildInvoiceLines } from '../domain/billing.js';
import { splitShares, taxFor, taxLineFor } from '../domain/tax.js';
import { onInvoiceIssued } from '../einvoice/service.js';
import { recordPayment } from '../payments.js';
import { noShowFee, prepaymentRequired } from '../domain/patientPolicy.js';
import { audit, getOr404, HttpError, notify, now, requireRole, wrap, wrapAsync, requireStaff } from '../http.js';
import { ensureStock, itemsFor, queueGoodsIssue } from '../stock.js';
import { noShowDates, setStatus, visitFee } from './requests.js';
import { ConsentInput, ensureConsent } from './consent.js';

const FIELD_ROLES = ['DOCTOR', 'NURSE', 'LAB_TECH', 'RADIOGRAPHER', 'DRIVER'];

function nextInvoiceNo(db: Db): string {
  const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM invoices')!.n + 1;
  return `INV-${String(n).padStart(6, '0')}`;
}

export interface InvoiceLineInput {
  sourceType: string;
  sourceId: number;
  description: string;
  qty: number;
  unitPrice: number;
  amount: number;
  payerAmount: number;
  patientAmount: number;
  serviceCode?: string;
}

/**
 * Create an invoice (DRAFT). Each line gets its tax from owner settings: with tax-inclusive prices the
 * amounts stay as quoted and the tax is extracted; otherwise tax is added and split payer/patient pro rata.
 */
export function createInvoice(
  db: Db,
  head: { patient_id: number; kind: 'VISIT' | 'PERIODIC' | 'FINAL'; episode_id?: number; request_id?: number; period_from?: Date; period_to?: Date },
  lines: InvoiceLineInput[],
): number {
  const priced = lines.map((l) => {
    const svcLine = l.serviceCode ? db.get<{ line: string }>('SELECT line FROM services WHERE code = ?', l.serviceCode)?.line : null;
    const t = taxFor(taxLineFor(l.sourceType, svcLine), l.amount);
    const { payerGross, patientGross } = splitShares(t, l.payerAmount, l.patientAmount);
    return { ...l, t, payerGross, patientGross };
  });
  const sum = (f: (x: (typeof priced)[number]) => number) => priced.reduce((a, x) => a + f(x), 0);
  const id = db.insert('invoices', {
    invoice_no: nextInvoiceNo(db), ...head,
    subtotal: sum((x) => x.t.net), tax_total: sum((x) => x.t.tax),
    total: sum((x) => x.t.gross), payer_total: sum((x) => x.payerGross), patient_total: sum((x) => x.patientGross),
  });
  for (const x of priced) {
    db.insert('invoice_lines', {
      invoice_id: id, source_type: x.sourceType, source_id: x.sourceId, description: x.description,
      qty: x.qty, unit_price: x.unitPrice, amount: x.t.gross, payer_amount: x.payerGross, patient_amount: x.patientGross,
      service_code: x.serviceCode, tax_line: x.t.taxLine, tax_category: x.t.category, tax_rate: x.t.rate,
      net_amount: x.t.net, tax_amount: x.t.tax,
    });
  }
  return id;
}

/** A credit note that mirrors an invoice line by line (amounts, tax and shares negated exactly). */
export function createCreditNote(db: Db, originalId: number, reason: string): number {
  const o = db.get('SELECT * FROM invoices WHERE id = ?', originalId)!;
  const id = db.insert('invoices', {
    invoice_no: nextInvoiceNo(db), patient_id: o.patient_id, episode_id: o.episode_id, request_id: o.request_id, kind: o.kind,
    subtotal: -(o.subtotal ?? o.total), tax_total: -(o.tax_total ?? 0), total: -o.total, payer_total: -o.payer_total, patient_total: -o.patient_total,
    credit_for: o.id, void_reason: reason,
  });
  for (const l of db.all('SELECT * FROM invoice_lines WHERE invoice_id = ?', o.id)) {
    db.insert('invoice_lines', {
      invoice_id: id, source_type: l.source_type, source_id: l.source_id, description: `Cancels ${o.invoice_no}: ${l.description}`,
      qty: -l.qty, unit_price: l.unit_price, amount: -l.amount, payer_amount: -l.payer_amount, patient_amount: -l.patient_amount,
      service_code: l.service_code, tax_line: l.tax_line, tax_category: l.tax_category, tax_rate: l.tax_rate,
      net_amount: l.net_amount == null ? null : -l.net_amount, tax_amount: l.tax_amount == null ? null : -l.tax_amount,
    });
  }
  return id;
}

/** Issue an invoice: it becomes final, the e-invoice is queued (owner setting) and the ERP is told. */
export function issueInvoice(db: Db, invoiceId: number, at: Date = new Date()) {
  db.update('invoices', invoiceId, { status: 'ISSUED', issued_at: at });
  onInvoiceIssued(db, invoiceId);
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
    requireStaff(db, req);
    const staffId = Number(req.query.staffId);
    return staffId
      ? db.all(`SELECT v.*, r.request_no, p.full_name, p.address, p.lat, p.lng,
                  EXISTS (SELECT 1 FROM consents c WHERE c.patient_id = p.id AND c.type = 'GENERAL_TREATMENT' AND c.revoked_at IS NULL
                          AND (c.expires_at IS NULL OR c.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))) AS has_consent
                FROM visits v
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
    const body = z.object({ otp: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), consent: ConsentInput.optional() }).parse(req.body);
    const { visit, staff, request } = ownVisit(db, req);
    if (visit.status !== 'DISPATCHED') throw new HttpError(409, `Visit is ${visit.status}, dispatch it first`);
    const patient = getOr404(db, 'patients', request.patient_id);
    let method: string;
    if (body.otp) {
      if (body.otp !== visit.otp) throw new HttpError(400, 'Wrong visit code');
      method = 'OTP';
    } else if (body.lat !== undefined && body.lng !== undefined && patient.lat !== null) {
      const d = distanceMetres({ lat: body.lat, lng: body.lng }, { lat: patient.lat, lng: patient.lng });
      if (d > cfg().checkInRadiusM) throw new HttpError(400, `You are ${Math.round(d)} m from the patient address`);
      method = 'GPS';
    } else throw new HttpError(400, 'Send the visit code or GPS position');
    return db.tx(() => {
      // BR-80: no treatment, sample or image without the patient's (or guardian's) consent.
      ensureConsent(db, patient, visit.kind, now(req), staff.id, body.consent);
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
      const fee = noShowFee(visitFee(db, request.id));
      const invoiceId = createInvoice(db, { patient_id: request.patient_id, kind: 'VISIT', request_id: request.id }, buildInvoiceLines(
        [{ sourceType: 'VISIT', sourceId: visit.id, description: 'No-show fee', qty: 1, unitPrice: fee }], null));
      // BR-24: from the 2nd no-show in 30 days the next booking must be prepaid.
      const prepay = prepaymentRequired(noShowDates(db, request.patient_id), now(req));
      notify(db, 'role:COORDINATOR', 'PUSH', `${request.request_no}: patient no-show, reschedule${prepay ? ' (prepayment required, BR-24)' : ''}`);
      return { status: 'NO_SHOW', invoiceId, fee, prepaymentRequired: prepay };
    });
  }));

  // Direct service done: result / device handover, invoice from the accepted quote, payment.
  r.post('/:id/complete', wrapAsync(async (req) => {
    const body = z.object({
      // Materials actually used, when they differ from the service's mapped material.
      stockItems: z.array(z.object({ material: z.string().min(1), qty: z.number().positive() })).optional(),
      result: z.object({ report: z.string(), critical: z.boolean().default(false) }).optional(),
      rental: z.object({ serialNo: z.string(), expectedReturn: z.string(), handoverSigned: z.literal(true), deposit: z.number().int().default(0) }).optional(),
      payment: z.object({ method: z.enum(['CASH', 'CARD', 'LINK', 'TRANSFER', 'CLIQ']), amount: z.number().int().positive(), reference: z.string().optional() }).optional(),
    }).parse(req.body);
    const { visit, staff, request } = ownVisit(db, req);
    if (visit.status !== 'CHECKED_IN') throw new HttpError(409, 'Check in first');
    if (request.route !== 'DIRECT') throw new HttpError(409, 'Assessment and nursing visits are completed by opening an episode');
    const at = now(req);
    const reqItems = db.all('SELECT i.*, s.department, s.line, s.name_en FROM request_items i JOIN services s ON s.code = i.service_code WHERE request_id = ?', request.id);
    // Stock first: a device counts as one unit (its quantity is rental days); the owner decides warn or block.
    const stockItems = body.stockItems?.length ? body.stockItems : reqItems.flatMap((it) => itemsFor(it.service_code, it.line === 'DEV' ? 1 : it.qty));
    const stock = await ensureStock(db, stockItems);

    return db.tx(() => {
      const items = reqItems;
      queueGoodsIssue(db, stockItems, { reference: `VISIT-${visit.id}`, patientId: request.patient_id, staffId: staff.id });
      const out: Record<string, unknown> = {};
      for (const it of items) {
        if (it.line === 'LAB' || it.line === 'IMG') {
          const orderId = db.insert('orders', { request_id: request.id, service_code: it.service_code, department: it.department, ordered_by: staff.id, status: body.result ? 'VALIDATED' : 'IN_PROGRESS' });
          if (body.result) {
            const resultId = db.insert('results', { order_id: orderId, patient_id: request.patient_id, report: body.result.report, critical: body.result.critical, validated_by: staff.id, released_at: body.result.critical ? undefined : at, created_at: at });
            out.resultId = resultId;
            if (body.result.critical) notify(db, 'role:DOCTOR', 'CALL', `CRITICAL result for ${request.request_no}: acknowledge result ${resultId}`);
            else notify(db, `patient:${request.patient_id}`, 'PUSH', `Your ${it.name_en} result is ready`);
          }
        }
        if (it.line === 'DEV') {
          if (!body.rental) throw new HttpError(400, 'Device handover needs rental details and a signed handover form');
          const price = db.get(`SELECT unit_price FROM price_items WHERE service_code = ? AND payer_id IS NULL`, it.service_code);
          const paidDays = Math.round(it.qty);
          out.rentalId = db.insert('rentals', {
            paid_days: paidDays,
            patient_id: request.patient_id, request_id: request.id, service_code: it.service_code, serial_no: body.rental.serialNo,
            start_date: at, expected_return: body.rental.expectedReturn, daily_rate: price?.unit_price ?? 0, deposit: body.rental.deposit,
          });
        }
      }

      const quote = db.get(`SELECT * FROM quotes WHERE request_id = ? AND status = 'ACCEPTED'`, request.id);
      if (!quote) throw new HttpError(409, 'No accepted quote');
      const lines = (JSON.parse(quote.lines) as any[]).map((l) => ({
        sourceType: 'VISIT' as const, sourceId: visit.id, description: l.serviceCode, serviceCode: l.serviceCode, qty: l.qty, unitPrice: Math.round(l.net / l.qty),
        amount: l.net, payerAmount: l.payerShare, patientAmount: l.patientShare,
      }));
      const invoiceId = createInvoice(db, { patient_id: request.patient_id, kind: 'VISIT', request_id: request.id }, lines);
      issueInvoice(db, invoiceId, at);
      // Money taken before the visit (BR-24 / BR-15) settles the invoice first.
      for (const pre of db.all(`SELECT * FROM prepayments WHERE request_id = ? AND applied_invoice_id IS NULL`, request.id)) {
        recordPayment(db, invoiceId, { method: pre.method, amount: pre.amount, reference: pre.reference ?? `prepayment #${pre.id}`, collectedBy: pre.collected_by, at: pre.at });
        db.update('prepayments', pre.id, { applied_invoice_id: invoiceId });
      }
      if (body.payment) {
        recordPayment(db, invoiceId, { method: body.payment.method, amount: body.payment.amount, reference: body.payment.reference, collectedBy: staff.id });
      }

      db.update('visits', visit.id, { status: 'COMPLETED', completed_at: at });
      setStatus(db, request, 'COMPLETED', staff.id);
      audit(db, staff.id, 'COMPLETE_VISIT', 'visits', visit.id);
      return { status: 'COMPLETED', invoiceId, ...out, stockWarnings: stock.warnings };
    });
  }));

  return r;
}
