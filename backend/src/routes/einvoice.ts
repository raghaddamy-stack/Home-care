// Invoice document (for screen / print) with the tax authority QR, and e-invoice monitoring for finance.
import { Router } from 'express';
import QRCode from 'qrcode';
import type { Db, Row } from '../db.js';
import { getOr404, HttpError, requireRole, wrap, wrapAsync } from '../http.js';
import { cfg } from '../settings.js';
import { EInvoiceError, processEInvoiceQueue, queueEInvoice, setupProblems, submitEInvoice } from '../einvoice/service.js';
import { patientFromToken } from './patientApp.js';

/** Everything needed to show or print a tax invoice. */
export async function invoiceDocument(db: Db, inv: Row) {
  const s = cfg();
  const patient = db.get('SELECT id, national_id, full_name, phone, address FROM patients WHERE id = ?', inv.patient_id)!;
  const lines = db.all(
    `SELECT l.id, l.description, l.qty, l.unit_price, l.amount, l.net_amount, l.tax_amount, l.tax_category, l.tax_rate,
       l.payer_amount, l.patient_amount, s.name_ar, s.name_en
     FROM invoice_lines l LEFT JOIN services s ON s.code = l.service_code WHERE l.invoice_id = ? ORDER BY l.id`, inv.id);
  const e = db.get('SELECT status, uuid, icv, qr, einv_number, message, type_code, submitted_at FROM einvoices WHERE invoice_id = ?', inv.id);
  const qrSvg = e?.qr ? await QRCode.toString(e.qr, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 }) : null;
  return {
    invoice: {
      id: inv.id, number: inv.invoice_no, kind: inv.kind, status: inv.status, issuedAt: inv.issued_at ?? inv.created_at,
      periodFrom: inv.period_from, periodTo: inv.period_to,
      subtotal: inv.subtotal ?? inv.total, taxTotal: inv.tax_total ?? 0, total: inv.total, payerTotal: inv.payer_total, patientTotal: inv.patient_total,
      paid: db.get<{ s: number | null }>('SELECT SUM(amount) AS s FROM payments WHERE invoice_id = ?', inv.id)!.s ?? 0,
    },
    seller: { name: s.sellerName, tin: s.sellerTin, incomeSourceSequence: s.incomeSourceSequence },
    buyer: patient,
    pricesIncludeTax: s.pricesIncludeTax,
    lines,
    einvoice: e ? { ...e, qrSvg } : null,
  };
}

export function einvoiceRoutes(db: Db): Router {
  const r = Router();

  r.get('/invoices/:id/document', wrapAsync(async (req) => {
    requireRole(db, req, 'FINANCE', 'COORDINATOR', 'AGENT');
    return invoiceDocument(db, getOr404(db, 'invoices', req.params.id, 'Invoice'));
  }));

  r.get('/me/invoices/:id/document', wrapAsync(async (req) => {
    const p = patientFromToken(db, req);
    const inv = db.get(`SELECT * FROM invoices WHERE id = ? AND patient_id = ? AND status != 'DRAFT'`, Number(req.params.id), p.id);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    return invoiceDocument(db, inv);
  }));

  // Send (or resend after fixing data) one invoice now.
  r.post('/invoices/:id/einvoice', wrapAsync(async (req) => {
    requireRole(db, req, 'FINANCE');
    const inv = getOr404(db, 'invoices', req.params.id, 'Invoice');
    const problems = setupProblems();
    if (problems.length) throw new HttpError(409, `Complete the e-invoicing setup first: ${problems.join('، ')}`);
    let e: Row;
    try { e = queueEInvoice(db, inv.id); } catch (err) { if (err instanceof EInvoiceError) throw new HttpError(409, err.message); throw err; }
    if (e.status === 'REJECTED') db.update('einvoices', e.id, { status: 'PENDING', message: null });
    const out = await submitEInvoice(db, e.id);
    return { status: out.status, message: out.message, number: out.einv_number, uuid: out.uuid };
  }));

  r.get('/invoices/:id/einvoice.xml', wrap((req, res) => {
    requireRole(db, req, 'FINANCE');
    const e = db.get('SELECT xml FROM einvoices WHERE invoice_id = ?', Number(req.params.id));
    if (!e?.xml) throw new HttpError(404, 'No e-invoice XML yet');
    res.type('application/xml').send(e.xml);
  }));

  // Finance monitor: what was sent, what failed and why.
  r.get('/einvoices', wrap((req) => {
    requireRole(db, req, 'FINANCE');
    const status = (req.query.status as string | undefined) ?? null;
    return {
      setupProblems: setupProblems(),
      provider: cfg().einvoiceProvider,
      counts: db.all(`SELECT status, COUNT(*) AS n FROM einvoices GROUP BY status`),
      items: db.all(
        `SELECT x.id, x.invoice_id, x.status, x.uuid, x.icv, x.einv_number, x.message, x.attempts, x.submitted_at, x.type_code,
           i.invoice_no, i.total, p.full_name
         FROM einvoices x JOIN invoices i ON i.id = x.invoice_id JOIN patients p ON p.id = i.patient_id
         WHERE (? IS NULL OR x.status = ?) ORDER BY x.id DESC LIMIT 200`, status, status),
      notSent: db.all(
        `SELECT i.id, i.invoice_no, i.total, i.status FROM invoices i LEFT JOIN einvoices x ON x.invoice_id = i.id
         WHERE x.id IS NULL AND i.status IN ('ISSUED','PARTIALLY_PAID','PAID') ORDER BY i.id DESC LIMIT 100`),
    };
  }));

  r.post('/einvoices/process', wrapAsync(async (req) => {
    requireRole(db, req, 'FINANCE');
    return { processed: await processEInvoiceQueue(db) };
  }));

  return r;
}
