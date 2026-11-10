// E-invoicing workflow: queue on issue, build UBL, submit to JoFotara (or the mock), store the QR, retry on outages.
import { createHash, randomUUID } from 'node:crypto';
import type { Db, Row } from '../db.js';
import { notify } from '../http.js';
import { cfg } from '../settings.js';
import { emit } from '../webhooks.js';
import { buildUbl, type UblInvoice } from './ubl.js';

const RETRY_MIN = [1, 5, 15, 60, 240];

export class EInvoiceError extends Error {}

/** Set by the server to run the queue right after an invoice is issued (tests leave it unset). */
let kick: (() => void) | null = null;
export const setQueueKick = (fn: () => void) => { kick = fn; };

/** Called whenever an invoice becomes ISSUED. */
export function onInvoiceIssued(db: Db, invoiceId: number) {
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', invoiceId)!;
  emit(db, 'invoice.issued', { invoiceId, invoiceNo: inv.invoice_no, total: inv.total, patientId: inv.patient_id });
  const s = cfg();
  if (s.einvoiceProvider !== 'NONE' && s.einvoiceAutoSubmit) {
    queueEInvoice(db, invoiceId);
    if (kick) setImmediate(kick); // after the current transaction commits
  }
}

/** Missing seller setup that would make the tax authority reject every invoice. */
export function setupProblems(): string[] {
  const s = cfg();
  const out: string[] = [];
  if (s.einvoiceProvider === 'NONE') out.push('الربط متوقف من الإعدادات');
  if (!s.sellerTin) out.push('الرقم الضريبي للشركة');
  if (!s.sellerName) out.push('اسم الشركة المسجّل');
  if (!s.incomeSourceSequence) out.push('رقم تسلسل مصدر الدخل');
  if (s.einvoiceProvider === 'JOFOTARA' && (!s.einvoiceClientId || !s.einvoiceSecretKey)) out.push('Client ID و Secret Key');
  return out;
}

export function queueEInvoice(db: Db, invoiceId: number): Row {
  const existing = db.get('SELECT * FROM einvoices WHERE invoice_id = ?', invoiceId);
  if (existing) return existing;
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv) throw new EInvoiceError('Invoice not found');
  if (!['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(inv.status)) throw new EInvoiceError('Only issued invoices go to the tax authority');
  // ICV: running counter of documents sent for this income source sequence.
  const icv = (db.get<{ n: number }>('SELECT COALESCE(MAX(icv), 0) AS n FROM einvoices')!.n) + 1;
  const id = db.insert('einvoices', {
    invoice_id: invoiceId, provider: cfg().einvoiceProvider, uuid: randomUUID(), icv,
    type_code: inv.total < 0 ? '381' : '388',
  });
  return db.get('SELECT * FROM einvoices WHERE id = ?', id)!;
}

/** Turn a stored invoice into the UBL document. */
export function toUbl(db: Db, e: Row): UblInvoice {
  const s = cfg();
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', e.invoice_id)!;
  const p = db.get('SELECT * FROM patients WHERE id = ?', inv.patient_id)!;
  const rows = db.all('SELECT l.*, s.name_ar FROM invoice_lines l LEFT JOIN services s ON s.code = l.service_code WHERE invoice_id = ? ORDER BY l.id', inv.id);
  const paid = db.get<{ s: number | null }>('SELECT SUM(amount) AS s FROM payments WHERE invoice_id = ?', inv.id)!.s ?? 0;
  const paymentKind = s.einvoicePaymentType === 'CASH' ? '011'
    : s.einvoicePaymentType === 'RECEIVABLE' ? '021'
    : paid >= inv.patient_total && inv.payer_total === 0 ? '011' : '021';

  let original: UblInvoice['original'];
  if (e.type_code === '381') {
    // A credit (e.g. advance nursing billed but not delivered) corrects the patient's last accepted invoice.
    const o = db.get(
      `SELECT i.invoice_no, i.total, x.uuid FROM einvoices x JOIN invoices i ON i.id = x.invoice_id
       WHERE x.status = 'ACCEPTED' AND x.type_code = '388' AND i.patient_id = ? AND (? IS NULL OR i.episode_id = ?) ORDER BY x.id DESC LIMIT 1`,
      inv.patient_id, inv.episode_id, inv.episode_id,
    );
    if (!o) throw new EInvoiceError('Credit note has no accepted original invoice to reference');
    original = { number: o.invoice_no, uuid: o.uuid, total: o.total, reason: 'Adjustment to services billed' };
  }

  return {
    number: inv.invoice_no,
    uuid: e.uuid,
    issueDate: (inv.issued_at ?? inv.created_at).slice(0, 10),
    typeCode: e.type_code,
    paymentKind,
    icv: e.icv,
    note: inv.period_from ? `Period ${inv.period_from.slice(0, 10)} to ${inv.period_to.slice(0, 10)}` : undefined,
    sellerTin: s.sellerTin,
    sellerName: s.sellerName,
    incomeSourceSequence: s.incomeSourceSequence,
    buyer: { idScheme: 'NIN', id: p.national_id, name: p.full_name, phone: p.phone ?? undefined },
    original,
    lines: rows.map((l, i) => {
      const net = l.net_amount ?? l.amount;
      return {
        id: i + 1,
        name: l.name_ar ?? l.description,
        qty: l.qty,
        unitNet: l.qty ? Math.round(net / l.qty) : net,
        net,
        tax: l.tax_amount ?? 0,
        category: (l.tax_category ?? 'O') as 'S' | 'Z' | 'O',
        rate: l.tax_rate ?? 0,
      };
    }),
  };
}

/** Mock tax authority: accepts and returns a QR payload built like the real one (seller, TIN, time, totals, UUID). */
function mockQr(ubl: UblInvoice, xml: string): string {
  const total = ubl.lines.reduce((a, l) => a + l.net + l.tax, 0);
  const tax = ubl.lines.reduce((a, l) => a + l.tax, 0);
  const fields = [ubl.sellerName, ubl.sellerTin, new Date().toISOString(), (Math.abs(total) / 1000).toFixed(3), (Math.abs(tax) / 1000).toFixed(3), ubl.uuid, createHash('sha256').update(xml).digest('base64')];
  const tlv = Buffer.concat(fields.map((v, i) => { const b = Buffer.from(v, 'utf8'); return Buffer.concat([Buffer.from([i + 1, b.length]), b]); }));
  return tlv.toString('base64');
}

/** Submit one e-invoice. Rejections are final (fix data and resubmit); outages are retried with back-off. */
export async function submitEInvoice(db: Db, einvoiceId: number, fetchImpl: typeof fetch = fetch): Promise<Row> {
  const e = db.get('SELECT * FROM einvoices WHERE id = ?', einvoiceId)!;
  if (e.status === 'ACCEPTED') return e;
  const s = cfg();
  const problems = setupProblems();
  const fail = (status: 'REJECTED' | 'FAILED', message: string, retry: boolean) => {
    db.update('einvoices', e.id, {
      status, message: message.slice(0, 2000), attempts: e.attempts + 1,
      next_attempt_at: retry ? new Date(Date.now() + RETRY_MIN[Math.min(e.attempts, RETRY_MIN.length - 1)] * 60_000) : null,
    });
    db.run(`UPDATE invoices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, e.invoice_id);
    if (status === 'REJECTED') {
      emit(db, 'einvoice.rejected', { invoiceId: e.invoice_id, message });
      notify(db, 'role:FINANCE', 'PUSH', `E-invoice for invoice #${e.invoice_id} rejected: ${message.slice(0, 120)}`);
    }
    return db.get('SELECT * FROM einvoices WHERE id = ?', e.id)!;
  };
  if (problems.length) return fail('FAILED', `Setup incomplete: ${problems.join(', ')}`, false);

  let ubl: UblInvoice;
  let xml: string;
  try {
    ubl = toUbl(db, e);
    xml = buildUbl(ubl);
  } catch (err) {
    return fail('REJECTED', (err as Error).message, false);
  }
  db.update('einvoices', e.id, { xml, provider: s.einvoiceProvider, submitted_at: new Date() });

  let qr: string | undefined;
  let number: string | undefined;
  if (s.einvoiceProvider === 'MOCK') {
    qr = mockQr(ubl, xml);
    number = `MOCK-${e.icv}`;
  } else {
    let res: Response;
    try {
      res = await fetchImpl(s.einvoiceEndpoint, {
        method: 'POST',
        headers: { 'Client-Id': s.einvoiceClientId, 'Secret-Key': s.einvoiceSecretKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return fail('FAILED', `Tax system unreachable: ${(err as Error).message}`, true);
    }
    const body: any = await res.json().catch(() => ({}));
    const message = [body.EINV_MESSAGE, body.EINV_RESULTS && JSON.stringify(body.EINV_RESULTS)].filter(Boolean).join(' · ') || `HTTP ${res.status}`;
    if (res.status >= 500 || res.status === 429) return fail('FAILED', message, true);
    if (!res.ok || !body.EINV_QR) return fail('REJECTED', message, false);
    qr = body.EINV_QR;
    number = body.EINV_NUM;
  }

  db.update('einvoices', e.id, { status: 'ACCEPTED', qr, einv_number: number, message: null, attempts: e.attempts + 1, next_attempt_at: null });
  db.run(`UPDATE invoices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, e.invoice_id);
  emit(db, 'einvoice.accepted', { invoiceId: e.invoice_id, uuid: e.uuid, number });
  return db.get('SELECT * FROM einvoices WHERE id = ?', e.id)!;
}

/** Send everything pending or due for retry. The server runs this every minute. */
export async function processEInvoiceQueue(db: Db, fetchImpl: typeof fetch = fetch): Promise<number> {
  if (cfg().einvoiceProvider === 'NONE') return 0;
  const due = db.all<{ id: number }>(
    `SELECT id FROM einvoices WHERE status = 'PENDING' OR (status = 'FAILED' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?) ORDER BY id LIMIT 20`,
    new Date().toISOString(),
  );
  for (const { id } of due) await submitEInvoice(db, id, fetchImpl);
  return due.length;
}
