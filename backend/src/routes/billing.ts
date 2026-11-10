// Periodic (weekly / monthly) invoicing from verified attendance, final invoice, payments.
import { Router } from 'express';
import { z } from 'zod';
import type { Db, Row } from '../db.js';
import { buildInvoiceLines, nextPeriod, previousPeriod, rentalDaysInPeriod, type BillableSource, type Period } from '../domain/billing.js';
import { audit, getOr404, HttpError, notify, now, requireRole, wrap } from '../http.js';
import { createInvoice } from './visits.js';
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
export function invoiceEpisode(db: Db, ep: Row, period: Period, kind: 'PERIODIC' | 'FINAL', advance?: Period): number | null {
  const policy = ep.policy_id ? db.get('SELECT * FROM insurance_policies WHERE id = ?', ep.policy_id) : undefined;
  const payerId = policy?.payer_id ?? null;
  const code = ep.shift_service_code ?? 'NRS-HOUR';
  const hourly = unitPrice(db, code, payerId);

  const shifts = db.all(
    `SELECT * FROM shifts WHERE episode_id = ? AND status = 'COMPLETED' AND invoice_id IS NULL
     AND planned_start >= ? AND planned_start < ?`,
    ep.id, period.from.toISOString(), period.to.toISOString(),
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
  for (const rent of db.all(`SELECT * FROM rentals WHERE episode_id = ?`, ep.id)) {
    const days = rentalDaysInPeriod(new Date(rent.start_date), rent.returned_at ? new Date(rent.returned_at) : null, period);
    if (days > 0) sources.push({ sourceType: 'RENTAL', sourceId: rent.id, qty: days, unitPrice: rent.daily_rate, description: `${rent.service_code} rental (${days} days)` });
  }
  if (sources.length === 0) return null;

  const covered: string[] = policy ? JSON.parse(policy.covered_codes) : [];
  const copay = policy && covered.includes(code) ? policy.copay_pct : null;
  const shown = advance ?? period;
  const invoiceId = createInvoice(db, { patient_id: ep.patient_id, episode_id: ep.id, kind, period_from: shown.from, period_to: shown.to }, buildInvoiceLines(sources, copay));
  for (const s of shifts) db.update('shifts', s.id, { invoice_id: invoiceId });
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
      `SELECT * FROM episodes WHERE status IN ('ACTIVE','ON_HOLD','DISCHARGED') AND (? IS NULL OR billing_cycle = ?)`,
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

  // Final invoice at discharge: everything not yet billed up to the discharge date.
  r.post('/episodes/:id/final-invoice', wrap((req) => {
    requireRole(db, req, 'FINANCE');
    const ep = getOr404(db, 'episodes', req.params.id, 'Episode');
    if (ep.status !== 'DISCHARGED') throw new HttpError(409, 'Discharge the episode first');
    const lastBilled = db.get<{ to: string | null }>(`SELECT MAX(period_to) AS "to" FROM invoices WHERE episode_id = ?`, ep.id)?.to;
    const period = { from: new Date(lastBilled ?? ep.started_at), to: new Date(ep.discharged_at) };
    const id = db.tx(() => invoiceEpisode(db, ep, period, 'FINAL'));
    return { invoiceId: id };
  }));

  r.get('/invoices', wrap((req) => {
    const patientId = Number(req.query.patientId) || null;
    return db.all('SELECT * FROM invoices WHERE (? IS NULL OR patient_id = ?) ORDER BY id DESC LIMIT 200', patientId, patientId);
  }));

  r.get('/invoices/:id', wrap((req) => {
    const inv = getOr404(db, 'invoices', req.params.id, 'Invoice');
    return {
      ...inv,
      lines: db.all('SELECT * FROM invoice_lines WHERE invoice_id = ?', inv.id),
      payments: db.all('SELECT * FROM payments WHERE invoice_id = ?', inv.id),
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
    db.update('invoices', inv.id, { status: 'ISSUED' });
    notify(db, `patient:${inv.patient_id}`, 'SMS', `Invoice ${inv.invoice_no}: ${(inv.patient_total / 1000).toFixed(3)} JOD`);
    return { status: 'ISSUED' };
  }));

  r.post('/invoices/:id/payments', wrap((req, res) => {
    const staff = requireRole(db, req, 'FINANCE', 'DRIVER', 'NURSE', 'LAB_TECH');
    const body = z.object({ method: z.enum(['CASH', 'CARD', 'LINK', 'TRANSFER', 'CLIQ']), amount: z.number().int().positive(), reference: z.string().optional() }).parse(req.body);
    const inv = getOr404(db, 'invoices', req.params.id, 'Invoice');
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(inv.status)) throw new HttpError(409, `Invoice is ${inv.status}`);
    const out = db.tx(() => {
      const id = db.insert('payments', { invoice_id: inv.id, method: body.method, amount: body.amount, reference: body.reference, collected_by: staff.id });
      const paid = db.get<{ s: number }>('SELECT SUM(amount) AS s FROM payments WHERE invoice_id = ?', inv.id)!.s;
      const status = paid >= inv.patient_total ? 'PAID' : 'PARTIALLY_PAID';
      db.update('invoices', inv.id, { status });
      return { id, status, paid, balance: Math.max(0, inv.patient_total - paid) };
    });
    res.status(201).json(out);
  }));

  return r;
}
