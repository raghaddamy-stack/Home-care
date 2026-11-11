// The links that close each cycle: device return and extension, episode hold / resume, invoice void with a
// credit note, and insurer payments against the payer share.
import { Router } from 'express';
import { z } from 'zod';
import type { Db, Row } from '../db.js';
import { audit, getOr404, HttpError, notify, now, requireRole, requireStaff, wrap } from '../http.js';
import { buildInvoiceLines } from '../domain/billing.js';
import { createCreditNote, createInvoice, issueInvoice } from './visits.js';
import { recordPayerPayment } from '../payments.js';
import { maybeCloseEpisode } from '../closure.js';
import { emit } from '../webhooks.js';

const DAY = 86_400_000;

export function servicePrice(db: Db, code: string, payerId: number | null): number {
  const row = db.get<{ unit_price: number }>(
    `SELECT unit_price FROM price_items WHERE service_code = ? AND (payer_id = ? OR payer_id IS NULL) ORDER BY payer_id IS NULL LIMIT 1`,
    code, payerId,
  );
  if (!row) throw new HttpError(409, `No price for ${code}`);
  return row.unit_price;
}

/** Days a rental ran, counting any started day. */
export const rentalDays = (start: Date, end: Date) => Math.max(1, Math.ceil((end.getTime() - start.getTime()) / DAY));

function rentalView(db: Db, r: Row, at: Date) {
  const s = db.get<{ name_ar: string }>('SELECT name_ar FROM services WHERE code = ?', r.service_code);
  const p = db.get<{ full_name: string; phone: string; address: string }>('SELECT full_name, phone, address FROM patients WHERE id = ?', r.patient_id)!;
  const ep = r.episode_id ? db.get<{ episode_no: string; status: string }>('SELECT episode_no, status FROM episodes WHERE id = ?', r.episode_id) : undefined;
  return {
    ...r,
    name_ar: s?.name_ar ?? r.service_code,
    full_name: p.full_name, phone: p.phone, address: p.address,
    episode_no: ep?.episode_no ?? null,
    overdue: r.status === 'ACTIVE' && new Date(r.expected_return).getTime() < at.getTime(),
    // A device of a discharged patient has to come back now.
    pickupDue: r.status === 'ACTIVE' && (ep?.status === 'DISCHARGED' || new Date(r.expected_return).getTime() < at.getTime()),
  };
}

/** Unlink everything an invoice billed so it can be billed again (after a void). */
function releaseSources(db: Db, invoiceId: number) {
  db.run('UPDATE shifts SET invoice_id = NULL, advance_minutes = NULL WHERE invoice_id = ?', invoiceId);
  db.run('UPDATE orders SET invoice_id = NULL WHERE invoice_id = ?', invoiceId);
  db.run('UPDATE rentals SET return_invoice_id = NULL WHERE return_invoice_id = ?', invoiceId);
  // Rental days billed by this invoice become billable again.
  for (const l of db.all(`SELECT source_id, qty FROM invoice_lines WHERE invoice_id = ? AND source_type = 'RENTAL'`, invoiceId)) {
    const r = db.get<{ billed_until: string | null; start_date: string }>('SELECT billed_until, start_date FROM rentals WHERE id = ?', l.source_id);
    if (r?.billed_until) {
      const back = new Date(new Date(r.billed_until).getTime() - l.qty * DAY);
      db.update('rentals', l.source_id, { billed_until: back <= new Date(r.start_date) ? null : back });
    }
  }
}

export function lifecycleRoutes(db: Db): Router {
  const r = Router();

  // ---- Devices -----------------------------------------------------------------
  r.get('/rentals', wrap((req) => {
    requireStaff(db, req);
    const status = (req.query.status as string | undefined) ?? null;
    const at = now(req);
    return db.all(`SELECT * FROM rentals WHERE (? IS NULL OR status = ?) ORDER BY status, expected_return`, status, status).map((x) => rentalView(db, x, at));
  }));

  r.post('/rentals/:id/extend', wrap((req) => {
    const staff = requireRole(db, req, 'COORDINATOR', 'AGENT');
    const { expectedReturn } = z.object({ expectedReturn: z.string().min(10) }).parse(req.body);
    const rent = getOr404(db, 'rentals', req.params.id, 'Rental');
    if (rent.status !== 'ACTIVE') throw new HttpError(409, 'Device already returned');
    if (new Date(expectedReturn) <= new Date(rent.start_date)) throw new HttpError(400, 'Return date must be after the start');
    db.update('rentals', rent.id, { expected_return: expectedReturn });
    notify(db, `patient:${rent.patient_id}`, 'SMS', `Device rental extended until ${expectedReturn.slice(0, 10)}`);
    audit(db, staff.id, 'RENTAL_EXTEND', 'rentals', rent.id, { expectedReturn });
    return { id: rent.id, expectedReturn };
  }));

  // Device collected from the patient. Direct rentals: days beyond those paid upfront are invoiced now.
  // Home-care rentals are billed by the periodic / final invoice up to this date. Damage is charged separately.
  r.post('/rentals/:id/return', wrap((req) => {
    const staff = requireRole(db, req, 'DRIVER', 'COORDINATOR');
    const body = z.object({
      condition: z.enum(['OK', 'DAMAGED']).default('OK'),
      damageCharge: z.number().int().min(0).default(0),
      note: z.string().optional(),
    }).parse(req.body);
    const rent = getOr404(db, 'rentals', req.params.id, 'Rental');
    if (rent.status !== 'ACTIVE') throw new HttpError(409, 'Device already returned');
    if (body.condition === 'DAMAGED' && body.damageCharge === 0 && !body.note) throw new HttpError(400, 'Describe the damage or set a charge');
    const at = now(req);
    return db.tx(() => {
      db.update('rentals', rent.id, { status: 'RETURNED', returned_at: at, return_condition: body.condition, damage_charge: body.damageCharge || null });
      const used = rentalDays(new Date(rent.start_date), at);
      const lines: Parameters<typeof buildInvoiceLines>[0] = [];
      let extraDays = 0;
      if (!rent.episode_id) {
        extraDays = Math.max(0, used - (rent.paid_days ?? used));
        if (extraDays > 0) lines.push({ sourceType: 'RENTAL', sourceId: rent.id, qty: extraDays, unitPrice: rent.daily_rate, description: `${rent.service_code} extra rental days`, serviceCode: rent.service_code });
      }
      if (body.damageCharge > 0) lines.push({ sourceType: 'RENTAL', sourceId: rent.id, qty: 1, unitPrice: body.damageCharge, description: `Damage: ${body.note ?? rent.service_code}`, serviceCode: rent.service_code });
      let invoiceId: number | undefined;
      if (lines.length) {
        invoiceId = createInvoice(db, { patient_id: rent.patient_id, kind: 'VISIT', request_id: rent.request_id ?? undefined, episode_id: undefined }, buildInvoiceLines(lines, null));
        issueInvoice(db, invoiceId, at);
        db.update('rentals', rent.id, { return_invoice_id: invoiceId });
      }
      const depositRefund = body.condition === 'OK' ? rent.deposit : Math.max(0, rent.deposit - body.damageCharge);
      if (depositRefund > 0) notify(db, 'role:FINANCE', 'PUSH', `Refund deposit ${(depositRefund / 1000).toFixed(3)} JOD for rental #${rent.id}`);
      emit(db, 'rental.returned', { rentalId: rent.id, patientId: rent.patient_id, condition: body.condition, extraDays, invoiceId: invoiceId ?? null, depositRefund });
      audit(db, staff.id, 'RENTAL_RETURN', 'rentals', rent.id, body);
      maybeCloseEpisode(db, rent.episode_id);
      return { status: 'RETURNED', daysUsed: used, extraDays, invoiceId: invoiceId ?? null, depositRefund };
    });
  }));

  // ---- Episode hold / resume -----------------------------------------------------
  r.post('/episodes/:id/hold', wrap((req) => {
    const staff = requireRole(db, req, 'DOCTOR', 'COORDINATOR', 'SUPERVISOR');
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    if (ep.status !== 'ACTIVE') throw new HttpError(409, `Episode is ${ep.status}`);
    db.update('episodes', ep.id, { status: 'ON_HOLD', hold_reason: reason });
    notify(db, 'role:COORDINATOR', 'PUSH', `${ep.episode_no} on hold: ${reason}`);
    audit(db, staff.id, 'EPISODE_HOLD', 'episodes', ep.id, reason);
    return { status: 'ON_HOLD' };
  }));

  r.post('/episodes/:id/resume', wrap((req) => {
    const staff = requireRole(db, req, 'DOCTOR', 'SUPERVISOR');
    const { note } = z.object({ note: z.string().min(3) }).parse(req.body);
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    if (ep.status !== 'ON_HOLD') throw new HttpError(409, `Episode is ${ep.status}`);
    db.update('episodes', ep.id, { status: 'ACTIVE', hold_reason: null });
    notify(db, 'role:COORDINATOR', 'PUSH', `${ep.episode_no} resumed: check the roster`);
    audit(db, staff.id, 'EPISODE_RESUME', 'episodes', ep.id, note);
    return { status: 'ACTIVE' };
  }));

  // ---- Invoice void (credit note) --------------------------------------------------
  r.post('/invoices/:id/void', wrap((req) => {
    const staff = requireRole(db, req, 'FINANCE');
    const { reason } = z.object({ reason: z.string().min(5) }).parse(req.body);
    const inv = getOr404(db, 'invoices', req.params.id, 'Invoice');
    if (inv.status === 'VOID') throw new HttpError(409, 'Invoice already void');
    if (inv.credit_for) throw new HttpError(409, 'A credit note cannot be voided');
    const paid = db.get<{ s: number | null }>('SELECT SUM(amount) AS s FROM payments WHERE invoice_id = ?', inv.id)!.s ?? 0;
    if (paid > 0 || inv.payer_paid > 0) throw new HttpError(409, 'Refund the payments recorded on this invoice before voiding it');
    const at = now(req);
    return db.tx(() => {
      // Free the unique (episode, period) slot so the corrected period can be billed again.
      db.update('invoices', inv.id, { status: 'VOID', void_reason: reason, period_from: inv.period_from ? `${inv.period_from}~void${inv.id}` : null });
      releaseSources(db, inv.id);
      let creditNoteId: number | undefined;
      if (inv.status !== 'DRAFT') {
        creditNoteId = createCreditNote(db, inv.id, reason);
        issueInvoice(db, creditNoteId, at);
      }
      emit(db, 'invoice.voided', { invoiceId: inv.id, invoiceNo: inv.invoice_no, reason, creditNoteId: creditNoteId ?? null });
      audit(db, staff.id, 'INVOICE_VOID', 'invoices', inv.id, { reason, creditNoteId });
      return { status: 'VOID', creditNoteId: creditNoteId ?? null };
    });
  }));

  // ---- Insurer receivable --------------------------------------------------------
  r.post('/invoices/:id/payer-payments', wrap((req, res) => {
    const staff = requireRole(db, req, 'FINANCE');
    const body = z.object({ amount: z.number().int().positive(), reference: z.string().optional() }).parse(req.body);
    const inv = getOr404(db, 'invoices', req.params.id, 'Invoice');
    if (!['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(inv.status)) throw new HttpError(409, `Invoice is ${inv.status}`);
    if (inv.payer_total <= 0) throw new HttpError(409, 'This invoice has no insurer share');
    if (inv.payer_paid + body.amount > inv.payer_total) throw new HttpError(400, 'More than the insurer share');
    res.status(201).json(db.tx(() => recordPayerPayment(db, inv.id, { amount: body.amount, reference: body.reference, recordedBy: staff.id, at: now(req) })));
  }));

  // Open insurer balances (what to claim / chase), per payer.
  r.get('/claims', wrap((req) => {
    requireRole(db, req, 'FINANCE');
    return db.all(
      `SELECT i.id, i.invoice_no, i.issued_at, i.payer_total, i.payer_paid, i.payer_total - i.payer_paid AS outstanding, p.full_name,
         COALESCE(py1.name, py2.name) AS payer_name
       FROM invoices i JOIN patients p ON p.id = i.patient_id
       LEFT JOIN service_requests r ON r.id = i.request_id LEFT JOIN insurance_policies pol1 ON pol1.id = r.policy_id LEFT JOIN payers py1 ON py1.id = pol1.payer_id
       LEFT JOIN episodes e ON e.id = i.episode_id LEFT JOIN insurance_policies pol2 ON pol2.id = e.policy_id LEFT JOIN payers py2 ON py2.id = pol2.payer_id
       WHERE i.status NOT IN ('DRAFT','VOID') AND i.payer_total > i.payer_paid ORDER BY i.issued_at`,
    );
  }));

  return r;
}
