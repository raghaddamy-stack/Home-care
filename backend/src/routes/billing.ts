// Periodic (weekly / monthly) invoicing from verified attendance, final invoice, payments.
import { Router } from 'express';
import { z } from 'zod';
import type { Db, Row } from '../db.js';
import { buildInvoiceLines, nextPeriod, previousPeriod, rentalDaysInPeriod, type BillableSource, type Period } from '../domain/billing.js';
import { audit, getOr404, HttpError, notify, now, requireRole, wrap } from '../http.js';
import { createInvoice, issueInvoice } from './visits.js';
import { recordPayment } from '../payments.js';
import { maybeCloseEpisode } from '../closure.js';
import { cfg } from '../settings.js';

function unitPrice(db: Db, code: string, payerId: number | null): number {
  const row = db.get(
    `SELECT unit_price FROM price_items WHERE service_code = ? AND (payer_id = ? OR payer_id IS NULL)
     ORDER BY payer_id IS NULL LIMIT 1`,
    code, payerId,
  );
  if (!row) throw new HttpError(409, `No price for ${code}`);
  return row.unit_price;
}

/**
 * Collect billable items of an episode and create one invoice (or null if nothing to bill):
 * - completed shifts of `period` not billed yet, at actual attendance;
 * - adjustments for shifts that were billed in advance and have now finished (actual − planned, or a credit if missed);
 * - with `advance`, the planned shifts of that coming period (owner setting nursingBillingMode = ADVANCE);
 * - device rental days inside `period`.
 */
export function invoiceEpisode(db: Db, ep: Row, period: Period, kind: 'PERIODIC' | 'FINAL', advance?: Period, sweep = kind === 'FINAL'): number | null {
  const policy = ep.policy_id ? db.get('SELECT * FROM insurance_policies WHERE id = ?', ep.policy_id) : undefined;
  const payerId = policy?.payer_id ?? null;
  const code = ep.shift_service_code ?? 'NRS-HOUR';
  const hourly = unitPrice(db, code, payerId);

  // The final invoice sweeps every completed shift not billed yet; a periodic one only its period.
  const shifts = db.all(
    `SELECT * FROM shifts WHERE episode_id = ? AND status = 'COMPLETED' AND invoice_id IS NULL
     AND planned_start >= ? AND planned_start < ?`,
    ep.id, sweep ? '0000' : period.from.toISOString(), period.to.toISOString(),
  );
  const sources: BillableSource[] = shifts.map((s) => ({
    sourceType: 'SHIFT', sourceId: s.id, qty: s.billable_minutes / 60, unitPrice: hourly,
    description: `Nursing ${s.planned_start.slice(0, 16).replace('T', ' ')} (${s.billable_minutes / 60} h)`,
  }));
  const fmt = (iso: string) => iso.slice(0, 16).replace('T', ' ');
  // Settle shifts billed in advance once they are over.
  const settleBefore = kind === 'FINAL' ? '9999' : period.to.toISOString();
  const toSettle = db.all(
    `SELECT * FROM shifts WHERE episode_id = ? AND advance_minutes IS NOT NULL AND adjusted_at IS NULL
     AND status IN ('COMPLETED','MISSED','CANCELLED') AND planned_start < ?`,
    ep.id, settleBefore,
  );
  for (const sh of toSettle) {
    const diff = (sh.status === 'COMPLETED' ? sh.billable_minutes : 0) - sh.advance_minutes;
    if (diff !== 0) sources.push({
      sourceType: 'SHIFT_ADJUST', sourceId: sh.id, qty: diff / 60, unitPrice: hourly,
      description: `Adjustment ${fmt(sh.planned_start)}: ${sh.status === 'COMPLETED' ? `actual ${sh.billable_minutes / 60} h` : 'not delivered'} vs ${sh.advance_minutes / 60} h billed in advance`,
    });
  }
  const planned = advance ? db.all(
    `SELECT * FROM shifts WHERE episode_id = ? AND invoice_id IS NULL AND status IN ('PLANNED','LATE','CHECKED_IN','COMPLETED')
     AND planned_start >= ? AND planned_start < ?`,
    ep.id, advance.from.toISOString(), advance.to.toISOString(),
  ) : [];
  for (const sh of planned) {
    const mins = (new Date(sh.planned_end).getTime() - new Date(sh.planned_start).getTime()) / 60_000;
    sources.push({ sourceType: 'SHIFT_PLANNED', sourceId: sh.id, qty: mins / 60, unitPrice: hourly, description: `Nursing (planned) ${fmt(sh.planned_start)} (${mins / 60} h)` });
  }
  // Rental days from where the last invoice stopped (billed_until), so no day is billed twice.
  const rentalEnds = new Map<number, Date>();
  for (const rent of db.all(`SELECT * FROM rentals WHERE episode_id = ?`, ep.id)) {
    const start = new Date(Math.max(new Date(rent.start_date).getTime(), rent.billed_until ? new Date(rent.billed_until).getTime() : 0));
    const days = rentalDaysInPeriod(start, rent.returned_at ? new Date(rent.returned_at) : null, sweep ? { from: start, to: period.to } : period);
    if (days > 0) {
      const from = new Date(Math.max(start.getTime(), sweep ? 0 : period.from.getTime()));
      rentalEnds.set(rent.id, new Date(from.getTime() + days * 86_400_000));
      sources.push({ sourceType: 'RENTAL', sourceId: rent.id, qty: days, unitPrice: rent.daily_rate, description: `${rent.service_code} rental (${days} days)` });
    }
  }
  // Lab, imaging and pharmacy orders delivered for the episode (devices are billed by rental day instead).
  const orders = db.all(
    `SELECT o.*, s.name_en FROM orders o JOIN services s ON s.code = o.service_code
     WHERE o.episode_id = ? AND o.invoice_id IS NULL AND o.status IN ('VALIDATED','ACKNOWLEDGED') AND o.department != 'EQUIPMENT' AND o.created_at < ?`,
    ep.id, kind === 'FINAL' ? '9999' : period.to.toISOString(),
  );
  for (const o of orders) {
    sources.push({ sourceType: 'ORDER', sourceId: o.id, qty: 1, unitPrice: unitPrice(db, o.service_code, payerId), description: `${o.name_en} (order #${o.id})`, serviceCode: o.service_code });
  }
  for (const src of sources) if (src.sourceType === 'RENTAL') src.serviceCode = db.get<{ service_code: string }>('SELECT service_code FROM rentals WHERE id = ?', src.sourceId)?.service_code;
  if (sources.length === 0) return null;

  const covered: string[] = policy ? JSON.parse(policy.covered_codes) : [];
  // Each line is covered (co-pay applies) only if the insurer covers that service.
  const copayFor = (src: BillableSource) => (policy && covered.includes(src.serviceCode ?? code) ? policy.copay_pct : null);
  const shown = advance ?? period;
  const invoiceId = createInvoice(db, { patient_id: ep.patient_id, episode_id: ep.id, kind, period_from: shown.from, period_to: shown.to },
    sources.map((src) => buildInvoiceLines([src], copayFor(src))[0]));
  for (const s of shifts) db.update('shifts', s.id, { invoice_id: invoiceId });
  for (const o of orders) db.update('orders', o.id, { invoice_id: invoiceId });
  for (const [id, until] of rentalEnds) db.update('rentals', id, { billed_until: until });
  const nowIso = new Date().toISOString();
  for (const s of toSettle) db.update('shifts', s.id, { adjusted_at: nowIso });
  for (const s of planned) {
    const mins = (new Date(s.planned_end).getTime() - new Date(s.planned_start).getTime()) / 60_000;
    db.update('shifts', s.id, { invoice_id: invoiceId, advance_minutes: mins });
  }
  return invoiceId;
}

export function billingRoutes(db: Db): Router {
  const r = Router();

  // Run the billing cycle. Safe to run repeatedly: each episode/period is invoiced once.
  r.post('/billing/run', wrap((req) => {
    const staff = requireRole(db, req, 'FINANCE');
    const body = z.object({ asOf: z.string().datetime().optional(), cycle: z.enum(['WEEKLY', 'MONTHLY']).optional() }).parse(req.body ?? {});
    const asOf = body.asOf ? new Date(body.asOf) : now(req);
    const episodes = db.all(
      `SELECT * FROM episodes WHERE status IN ('ACTIVE','ON_HOLD','DISCHARGED') AND final_billed_at IS NULL AND (? IS NULL OR billing_cycle = ?)`,
      body.cycle ?? null, body.cycle ?? null,
    );
    const created: number[] = [];
    db.tx(() => {
      for (const ep of episodes) {
        const period = previousPeriod(ep.billing_cycle, asOf);
        // ADVANCE: bill the coming period's roster now; actual attendance is settled on the next run.
        const advance = cfg().nursingBillingMode === 'ADVANCE' && ep.status !== 'DISCHARGED' ? nextPeriod(ep.billing_cycle, period) : undefined;
        const key = (advance ?? period).from.toISOString();
        const exists = db.get('SELECT id FROM invoices WHERE episode_id = ? AND period_from = ?', ep.id, key);
        if (exists) continue;
        const id = invoiceEpisode(db, ep, period, 'PERIODIC', advance);
        if (id) created.push(id);
      }
    });
    audit(db, staff.id, 'BILLING_RUN', 'invoices', 0, { asOf, created });
    return { created };
  }));

  // Interim invoice (e.g. monthly) while care continues: everything not billed yet, up to a date.
  r.post('/episodes/:id/interim-invoice', wrap((req) => {
    requireRole(db, req, 'FINANCE');
    if (!cfg().interimInvoicing) throw new HttpError(403, 'Interim invoices are switched off in the owner settings');
    const body = z.object({ upTo: z.string().min(10).optional() }).parse(req.body ?? {});
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    if (!['ACTIVE', 'ON_HOLD'].includes(ep.status)) throw new HttpError(409, ep.status === 'DISCHARGED' ? 'Care has ended: use the final invoice' : `Episode is ${ep.status}`);
    const to = body.upTo ? new Date(body.upTo.length === 10 ? `${body.upTo}T23:59:59` : body.upTo) : now(req);
    const lastBilled = db.get<{ to: string | null }>(`SELECT MAX(period_to) AS "to" FROM invoices WHERE episode_id = ? AND status != 'VOID'`, ep.id)?.to;
    const from = new Date(lastBilled ?? ep.started_at);
    if (to <= from) throw new HttpError(409, `Already billed up to ${from.toISOString().slice(0, 10)}`);
    if (db.get('SELECT 1 FROM invoices WHERE episode_id = ? AND period_from = ?', ep.id, from.toISOString())) throw new HttpError(409, 'An invoice for this period already exists');
    const id = db.tx(() => invoiceEpisode(db, ep, { from, to }, 'PERIODIC', undefined, true));
    if (!id) throw new HttpError(409, 'Nothing to bill up to that date');
    return { invoiceId: id, from, to };
  }));

  // Weekly or monthly automatic cycle for one patient.
  r.put('/episodes/:id/billing-cycle', wrap((req) => {
    const staff = requireRole(db, req, 'FINANCE', 'COORDINATOR');
    const { cycle } = z.object({ cycle: z.enum(['WEEKLY', 'MONTHLY']) }).parse(req.body);
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    db.update('episodes', ep.id, { billing_cycle: cycle });
    audit(db, staff.id, 'BILLING_CYCLE', 'episodes', ep.id, cycle);
    return { id: ep.id, billingCycle: cycle };
  }));

  // Final invoice at discharge: everything not yet billed up to the discharge date.
  r.post('/episodes/:id/final-invoice', wrap((req) => {
    requireRole(db, req, 'FINANCE');
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    if (ep.status !== 'DISCHARGED') throw new HttpError(409, 'Discharge the episode first');
    if (db.get(`SELECT 1 FROM rentals WHERE episode_id = ? AND status = 'ACTIVE'`, ep.id)) throw new HttpError(409, 'Collect the devices first: the final invoice bills rental days up to their return');
    if (db.get(`SELECT 1 FROM invoices WHERE episode_id = ? AND kind = 'FINAL' AND status != 'VOID'`, ep.id)) throw new HttpError(409, 'The final invoice already exists');
    // From the end of the last billed period to the later of discharge and the last device return.
    const lastBilled = db.get<{ to: string | null }>(`SELECT MAX(period_to) AS "to" FROM invoices WHERE episode_id = ? AND status != 'VOID'`, ep.id)?.to;
    const lastReturn = db.get<{ r: string | null }>(`SELECT MAX(returned_at) AS r FROM rentals WHERE episode_id = ?`, ep.id)?.r;
    const end = [ep.discharged_at, lastReturn].filter(Boolean).map((x) => new Date(x as string)).reduce((a, b) => (a > b ? a : b));
    const period = { from: new Date(lastBilled ?? ep.started_at), to: end };
    const id = db.tx(() => {
      const inv = invoiceEpisode(db, ep, period, 'FINAL');
      db.update('episodes', ep.id, { final_billed_at: new Date() });
      maybeCloseEpisode(db, ep.id);
      return inv;
    });
    return { invoiceId: id };
  }));

  r.get('/invoices', wrap((req) => {
    const patientId = Number(req.query.patientId) || null;
    requireRole(db, req, 'FINANCE', 'COORDINATOR');
    return db.all(
      `SELECT i.*, x.status AS einvoice_status, p.full_name FROM invoices i JOIN patients p ON p.id = i.patient_id
       LEFT JOIN einvoices x ON x.invoice_id = i.id WHERE (? IS NULL OR i.patient_id = ?) ORDER BY i.id DESC LIMIT 200`,
      patientId, patientId,
    );
  }));

  r.get('/invoices/:id', wrap((req) => {
    requireRole(db, req, 'FINANCE', 'COORDINATOR');
    const inv = getOr404(db, 'invoices', req.params.id, 'Invoice');
    return {
      ...inv,
      lines: db.all('SELECT * FROM invoice_lines WHERE invoice_id = ?', inv.id),
      payments: db.all('SELECT * FROM payments WHERE invoice_id = ?', inv.id),
      payerPayments: db.all('SELECT * FROM payer_payments WHERE invoice_id = ?', inv.id),
      creditNote: db.get('SELECT id, invoice_no FROM invoices WHERE credit_for = ?', inv.id) ?? null,
    };
  }));

  // Finance reviews attendance vs lines, then issues.
  r.post('/invoices/:id/issue', wrap((req) => {
    requireRole(db, req, 'FINANCE');
    const inv = getOr404(db, 'invoices', req.params.id, 'Invoice');
    if (inv.status !== 'DRAFT') throw new HttpError(409, `Invoice is ${inv.status}`);
    const mismatch = db.get(
      `SELECT l.id FROM invoice_lines l JOIN shifts s ON s.id = l.source_id
       WHERE l.invoice_id = ? AND l.source_type = 'SHIFT' AND abs(l.qty * 60 - s.billable_minutes) > 0.01`,
      inv.id,
    );
    if (mismatch) throw new HttpError(409, 'Invoice hours do not match attendance (BR-72)');
    issueInvoice(db, inv.id, now(req));
    maybeCloseEpisode(db, inv.episode_id);
    notify(db, `patient:${inv.patient_id}`, 'SMS', `Invoice ${inv.invoice_no}: ${(inv.patient_total / 1000).toFixed(3)} JOD`);
    return { status: 'ISSUED' };
  }));

  r.post('/invoices/:id/payments', wrap((req, res) => {
    const staff = requireRole(db, req, 'FINANCE', 'DRIVER', 'NURSE', 'LAB_TECH');
    const body = z.object({ method: z.enum(['CASH', 'CARD', 'LINK', 'TRANSFER', 'CLIQ']), amount: z.number().int().positive(), reference: z.string().optional() }).parse(req.body);
    const inv = getOr404(db, 'invoices', req.params.id, 'Invoice');
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(inv.status)) throw new HttpError(409, `Invoice is ${inv.status}`);
    const out = db.tx(() => {
      return recordPayment(db, inv.id, { method: body.method, amount: body.amount, reference: body.reference, collectedBy: staff.id });
    });
    res.status(201).json(out);
  }));

  return r;
}
