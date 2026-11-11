// One place to record a payment against an invoice: updates the status and tells the ERP.
import type { Db } from './db.js';
import { emit } from './webhooks.js';
import { maybeCloseEpisode } from './closure.js';

export interface PaymentInput {
  method: string;
  amount: number; // fils
  reference?: string;
  collectedBy?: number;
  at?: Date | string;
  source?: string; // e.g. 'ERP' for payments posted by the ERP
}

export function recordPayment(db: Db, invoiceId: number, p: PaymentInput) {
  const id = db.insert('payments', {
    invoice_id: invoiceId, method: p.method, amount: p.amount, reference: p.reference, collected_by: p.collectedBy, at: p.at,
  });
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', invoiceId)!;
  const paid = db.get<{ s: number }>('SELECT SUM(amount) AS s FROM payments WHERE invoice_id = ?', invoiceId)!.s;
  const status = paid >= inv.patient_total ? 'PAID' : 'PARTIALLY_PAID';
  if (status !== inv.status) db.update('invoices', invoiceId, { status });
  emit(db, 'payment.created', { paymentId: id, invoiceId, invoiceNo: inv.invoice_no, amount: p.amount, method: p.method, reference: p.reference ?? null, source: p.source ?? 'HOME_CARE' });
  if (status === 'PAID' && inv.status !== 'PAID') emit(db, 'invoice.paid', { invoiceId, invoiceNo: inv.invoice_no, paid });
  maybeCloseEpisode(db, inv.episode_id);
  return { id, status, paid, balance: Math.max(0, inv.patient_total - paid) };
}

/** Money from the insurer against the payer share. */
export function recordPayerPayment(db: Db, invoiceId: number, p: { amount: number; reference?: string; recordedBy?: number; source?: string; at?: Date | string }) {
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', invoiceId)!;
  const id = db.insert('payer_payments', { invoice_id: invoiceId, amount: p.amount, reference: p.reference, recorded_by: p.recordedBy, source: p.source ?? 'HOME_CARE', at: p.at });
  const paid = db.get<{ s: number }>('SELECT SUM(amount) AS s FROM payer_payments WHERE invoice_id = ?', invoiceId)!.s;
  db.update('invoices', invoiceId, { payer_paid: paid });
  emit(db, 'payer_payment.created', { paymentId: id, invoiceId, invoiceNo: inv.invoice_no, amount: p.amount, reference: p.reference ?? null });
  return { id, payerPaid: paid, payerBalance: Math.max(0, inv.payer_total - paid) };
}
