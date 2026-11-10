// ERP integration API (SAP S/4HANA via Integration Suite, Oracle, Odoo, Microsoft Dynamics, …).
// Auth: API key created by the owner (Authorization: Bearer hc_… or X-API-Key), with scopes.
// Money: decimal strings in JOD with 3 decimals ("12.500") plus integer fils, so no float rounding on either side.
import { Router, type Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Db, Row } from '../db.js';
import { audit, HttpError, requireRole, wrap, wrapAsync } from '../http.js';
import { recordPayment } from '../payments.js';
import { cfg, type TaxCategory, type TaxLine } from '../settings.js';
import { openApiSpec } from '../openapi.js';

export const SCOPES = ['invoices:read', 'invoices:ack', 'payments:read', 'payments:write', 'customers:read', 'customers:write', 'catalog:read', 'events:read'] as const;
export type Scope = (typeof SCOPES)[number];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const jod = (fils: number | null | undefined) => ((fils ?? 0) / 1000).toFixed(3);
const money = (fils: number | null | undefined) => ({ amount: jod(fils), fils: fils ?? 0 });

function client(db: Db, req: Request, scope: Scope): Row {
  const h = req.header('authorization') ?? '';
  const key = h.startsWith('Bearer ') ? h.slice(7) : req.header('x-api-key') ?? '';
  if (!key) throw new HttpError(401, 'API key required (Authorization: Bearer <key> or X-API-Key)');
  const c = db.get('SELECT * FROM api_clients WHERE key_hash = ? AND active = 1', sha(key));
  if (!c) throw new HttpError(401, 'Invalid or revoked API key');
  if (!JSON.parse(c.scopes).includes(scope)) throw new HttpError(403, `API key lacks scope ${scope}`);
  db.run('UPDATE api_clients SET last_used_at = ? WHERE id = ?', new Date().toISOString(), c.id);
  return c;
}

/** Cursor pagination on (updated_at, id) so a sync never misses or repeats rows. */
function page(req: Request) {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100)));
  const since = (req.query.updatedSince as string | undefined) ?? '1970-01-01T00:00:00.000Z';
  const cursor = req.query.cursor ? Buffer.from(String(req.query.cursor), 'base64url').toString('utf8').split('|') : null;
  return { limit, since, cursorAt: cursor?.[0] ?? null, cursorId: cursor ? Number(cursor[1]) : 0 };
}
const nextCursor = (rows: Row[], limit: number, atKey: string) =>
  rows.length === limit ? Buffer.from(`${rows[rows.length - 1][atKey]}|${rows[rows.length - 1].id}`).toString('base64url') : null;

function invoiceDto(db: Db, inv: Row) {
  const s = cfg();
  const p = db.get('SELECT id, national_id, full_name, phone, address, erp_code FROM patients WHERE id = ?', inv.patient_id)!;
  const policy = inv.request_id
    ? db.get('SELECT pol.*, py.name AS payer_name, py.erp_code AS payer_erp_code, py.type AS payer_type FROM service_requests r JOIN insurance_policies pol ON pol.id = r.policy_id JOIN payers py ON py.id = pol.payer_id WHERE r.id = ?', inv.request_id)
    : inv.episode_id
      ? db.get('SELECT pol.*, py.name AS payer_name, py.erp_code AS payer_erp_code, py.type AS payer_type FROM episodes e JOIN insurance_policies pol ON pol.id = e.policy_id JOIN payers py ON py.id = pol.payer_id WHERE e.id = ?', inv.episode_id)
      : undefined;
  const e = db.get('SELECT status, uuid, icv, einv_number, qr, type_code, message FROM einvoices WHERE invoice_id = ?', inv.id);
  const lines = db.all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY id', inv.id);
  const payments = db.all('SELECT id, method, amount, reference, at FROM payments WHERE invoice_id = ? ORDER BY id', inv.id);
  return {
    id: inv.id,
    number: inv.invoice_no,
    kind: inv.kind,
    documentType: inv.total < 0 ? 'CREDIT_NOTE' : 'INVOICE',
    status: inv.status,
    currency: 'JOD',
    issuedAt: inv.issued_at,
    createdAt: inv.created_at,
    updatedAt: inv.updated_at,
    period: inv.period_from ? { from: inv.period_from, to: inv.period_to } : null,
    customer: { id: p.id, erpCode: p.erp_code, nationalId: p.national_id, name: p.full_name, phone: p.phone, address: p.address },
    payer: policy ? { id: policy.payer_id, erpCode: policy.payer_erp_code, name: policy.payer_name, type: policy.payer_type, memberNo: policy.member_no } : null,
    totals: {
      net: money(inv.subtotal ?? inv.total), tax: money(inv.tax_total ?? 0), gross: money(inv.total),
      payerShare: money(inv.payer_total), patientShare: money(inv.patient_total),
      paid: money(payments.reduce((a, x) => a + x.amount, 0)),
    },
    pricesIncludeTax: s.pricesIncludeTax,
    costCenter: s.erpCostCenter || null,
    lines: lines.map((l, i) => ({
      lineNo: i + 1,
      sourceType: l.source_type,
      serviceCode: l.service_code,
      description: l.description,
      quantity: l.qty,
      unitPrice: money(l.unit_price),
      net: money(l.net_amount ?? l.amount),
      tax: { category: l.tax_category ?? 'O', rate: l.tax_rate ?? 0, amount: money(l.tax_amount ?? 0), erpTaxCode: s.erpTaxCodes[(l.tax_category ?? 'O') as TaxCategory] || null },
      gross: money(l.amount),
      payerShare: money(l.payer_amount),
      patientShare: money(l.patient_amount),
      glAccount: l.tax_line ? s.erpGlAccounts[l.tax_line as TaxLine] || null : null,
      revenueLine: l.tax_line,
    })),
    payments: payments.map((x) => ({ id: x.id, method: x.method, amount: money(x.amount), reference: x.reference, receivedAt: x.at })),
    eInvoice: e ? { status: e.status, uuid: e.uuid, icv: e.icv, number: e.einv_number, qr: e.qr, documentType: e.type_code, message: e.message } : null,
    erp: { documentNo: inv.erp_ref, syncedAt: inv.erp_synced_at },
  };
}

export function erpRoutes(db: Db): Router {
  const r = Router();

  r.get('/openapi.json', (_req, res) => res.json(openApiSpec));

  r.get('/invoices', wrap((req) => {
    client(db, req, 'invoices:read');
    const { limit, since, cursorAt, cursorId } = page(req);
    const status = req.query.status as string | undefined;
    const unsynced = req.query.unsynced === 'true';
    const rows = db.all(
      `SELECT * FROM invoices WHERE status != 'DRAFT' AND updated_at >= ?
         AND (? IS NULL OR updated_at > ? OR (updated_at = ? AND id > ?))
         AND (? IS NULL OR status = ?) AND (? = 0 OR erp_synced_at IS NULL)
       ORDER BY updated_at, id LIMIT ?`,
      since, cursorAt, cursorAt, cursorAt, cursorId, status ?? null, status ?? null, unsynced ? 1 : 0, limit,
    );
    return { data: rows.map((x) => invoiceDto(db, x)), nextCursor: nextCursor(rows, limit, 'updated_at') };
  }));

  r.get('/invoices/:id', wrap((req) => {
    client(db, req, 'invoices:read');
    const inv = db.get(`SELECT * FROM invoices WHERE (id = ? OR invoice_no = ?) AND status != 'DRAFT'`, Number(req.params.id) || 0, req.params.id);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    return invoiceDto(db, inv);
  }));

  r.get('/invoices/:id/qr.svg', wrapAsync(async (req, res) => {
    client(db, req, 'invoices:read');
    const e = db.get('SELECT qr FROM einvoices WHERE invoice_id = ?', Number(req.params.id));
    if (!e?.qr) throw new HttpError(404, 'No tax QR for this invoice yet');
    res.type('image/svg+xml').send(await QRCode.toString(e.qr, { type: 'svg', margin: 1 }));
    return undefined;
  }));

  // The ERP confirms it posted the invoice (e.g. SAP accounting document number).
  r.post('/invoices/:id/ack', wrap((req) => {
    const c = client(db, req, 'invoices:ack');
    const { erpDocumentNo } = z.object({ erpDocumentNo: z.string().min(1).max(100) }).parse(req.body);
    const inv = db.get(`SELECT * FROM invoices WHERE id = ? AND status != 'DRAFT'`, Number(req.params.id));
    if (!inv) throw new HttpError(404, 'Invoice not found');
    db.update('invoices', inv.id, { erp_ref: erpDocumentNo, erp_synced_at: new Date() });
    audit(db, undefined, 'ERP_ACK', 'invoices', inv.id, { client: c.name, erpDocumentNo });
    return { id: inv.id, erpDocumentNo };
  }));

  r.get('/payments', wrap((req) => {
    client(db, req, 'payments:read');
    const { limit, since } = page(req);
    const after = Number(req.query.afterId ?? 0);
    const rows = db.all(
      `SELECT p.*, i.invoice_no, i.patient_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id > ? AND p.at >= ? ORDER BY p.id LIMIT ?`,
      after, since, limit,
    );
    return {
      data: rows.map((x) => ({ id: x.id, invoiceId: x.invoice_id, invoiceNo: x.invoice_no, customerId: x.patient_id, method: x.method, amount: money(x.amount), reference: x.reference, receivedAt: x.at })),
      nextAfterId: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }));

  // A payment received in the ERP (bank transfer, insurer settlement). Idempotency-Key is required.
  r.post('/payments', wrap((req, res) => {
    const c = client(db, req, 'payments:write');
    const idem = req.header('idempotency-key');
    if (!idem) throw new HttpError(400, 'Idempotency-Key header is required');
    const prior = db.get('SELECT * FROM idempotency_keys WHERE client_id = ? AND key = ?', c.id, idem);
    if (prior) { res.status(prior.status).json(JSON.parse(prior.response)); return; }
    const body = z.object({
      invoiceId: z.number().int().optional(),
      invoiceNo: z.string().optional(),
      amount: z.string().regex(/^\d+(\.\d{1,3})?$/, 'amount must be a JOD decimal string, e.g. "12.500"'),
      method: z.enum(['TRANSFER', 'CARD', 'CASH', 'CLIQ', 'LINK', 'INSURER']).default('TRANSFER'),
      reference: z.string().max(200).optional(),
      receivedAt: z.string().datetime().optional(),
    }).refine((b) => b.invoiceId || b.invoiceNo, 'invoiceId or invoiceNo is required').parse(req.body);
    const inv = db.get('SELECT * FROM invoices WHERE id = ? OR invoice_no = ?', body.invoiceId ?? 0, body.invoiceNo ?? '');
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (!['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(inv.status)) throw new HttpError(409, `Invoice is ${inv.status}`);
    const fils = Math.round(Number(body.amount) * 1000);
    if (fils <= 0) throw new HttpError(400, 'amount must be positive');
    const out = db.tx(() => {
      const r2 = recordPayment(db, inv.id, {
        method: body.method === 'INSURER' ? 'TRANSFER' : body.method, amount: fils,
        reference: body.reference ?? `ERP ${c.name}`, at: body.receivedAt, source: 'ERP',
      });
      const response = { paymentId: r2.id, invoiceId: inv.id, invoiceStatus: r2.status, paid: money(r2.paid), balance: money(r2.balance) };
      db.insert('idempotency_keys', { client_id: c.id, key: idem, response, status: 201 });
      return response;
    });
    res.status(201).json(out);
  }));

  r.get('/customers', wrap((req) => {
    client(db, req, 'customers:read');
    const { limit, since, cursorAt, cursorId } = page(req);
    // Billing identity only: no clinical data leaves through the ERP API.
    const rows = db.all(
      `SELECT id, national_id, full_name, phone, address, erp_code, COALESCE(updated_at, created_at) AS updated_at FROM patients
       WHERE COALESCE(updated_at, created_at) >= ? AND (? IS NULL OR COALESCE(updated_at, created_at) > ? OR (COALESCE(updated_at, created_at) = ? AND id > ?))
       ORDER BY COALESCE(updated_at, created_at), id LIMIT ?`,
      since, cursorAt, cursorAt, cursorAt, cursorId, limit,
    );
    return {
      data: rows.map((x) => ({ id: x.id, erpCode: x.erp_code, nationalId: x.national_id, name: x.full_name, phone: x.phone, address: x.address, updatedAt: x.updated_at })),
      nextCursor: nextCursor(rows, limit, 'updated_at'),
    };
  }));

  // The ERP tells us its own customer / payer numbers (e.g. SAP Business Partner) so later invoices carry them.
  r.put('/customers/:id', wrap((req) => {
    client(db, req, 'customers:write');
    const { erpCode } = z.object({ erpCode: z.string().min(1).max(50) }).parse(req.body);
    const p = db.get('SELECT id FROM patients WHERE id = ?', Number(req.params.id));
    if (!p) throw new HttpError(404, 'Customer not found');
    db.update('patients', p.id, { erp_code: erpCode });
    return { id: p.id, erpCode };
  }));

  r.get('/payers', wrap((req) => {
    client(db, req, 'customers:read');
    return { data: db.all('SELECT id, name, type, erp_code AS erpCode FROM payers ORDER BY id') };
  }));

  r.put('/payers/:id', wrap((req) => {
    client(db, req, 'customers:write');
    const { erpCode } = z.object({ erpCode: z.string().min(1).max(50) }).parse(req.body);
    const p = db.get('SELECT id FROM payers WHERE id = ?', Number(req.params.id));
    if (!p) throw new HttpError(404, 'Payer not found');
    db.update('payers', p.id, { erp_code: erpCode });
    return { id: p.id, erpCode };
  }));

  r.get('/services', wrap((req) => {
    client(db, req, 'catalog:read');
    const s = cfg();
    const rows = db.all(`SELECT s.*, p.unit_price FROM services s LEFT JOIN price_items p ON p.service_code = s.code AND p.payer_id IS NULL ORDER BY s.code`);
    return {
      data: rows.map((x) => {
        const line = x.department === 'PHARMACY' ? 'NRS' : x.line;
        const t = s.taxRules[line as TaxLine];
        return {
          code: x.code, nameAr: x.name_ar, nameEn: x.name_en, line: x.line, unit: x.unit, cashPrice: money(x.unit_price),
          tax: { category: t.category, rate: t.rate, erpTaxCode: s.erpTaxCodes[t.category] || null }, glAccount: s.erpGlAccounts[line as TaxLine] || null,
        };
      }),
    };
  }));

  // Polling alternative to webhooks: all business events after a given id.
  r.get('/events', wrap((req) => {
    client(db, req, 'events:read');
    const after = Number(req.query.afterId ?? 0);
    const limit = Math.min(500, Number(req.query.limit ?? 100));
    const rows = db.all('SELECT id, event, payload, created_at FROM webhook_events WHERE id > ? ORDER BY id LIMIT ?', after, limit);
    return { data: rows.map((x) => ({ id: x.id, ...JSON.parse(x.payload) })), nextAfterId: rows.length ? rows[rows.length - 1].id : after };
  }));

  return r;
}

/** Owner screen: create, list and revoke API keys; see webhook delivery health. */
export function integrationAdminRoutes(db: Db): Router {
  const r = Router();

  r.get('/integrations', wrap((req) => {
    requireRole(db, req, 'ADMIN');
    return {
      scopes: SCOPES,
      clients: db.all('SELECT id, name, key_prefix, scopes, active, created_at, last_used_at FROM api_clients ORDER BY id DESC').map((c) => ({ ...c, scopes: JSON.parse(c.scopes) })),
      webhook: {
        url: cfg().erpWebhookUrl || null,
        counts: db.all('SELECT status, COUNT(*) AS n FROM webhook_events GROUP BY status'),
        recentFailures: db.all(`SELECT id, event, attempts, last_error, created_at FROM webhook_events WHERE status = 'FAILED' ORDER BY id DESC LIMIT 10`),
      },
    };
  }));

  r.post('/integrations/clients', wrap((req, res) => {
    const staff = requireRole(db, req, 'ADMIN');
    const body = z.object({ name: z.string().min(2).max(80), scopes: z.array(z.enum(SCOPES)).min(1) }).parse(req.body);
    const key = `hc_${randomBytes(24).toString('base64url')}`;
    const id = db.insert('api_clients', { name: body.name, key_prefix: key.slice(0, 10), key_hash: sha(key), scopes: body.scopes, created_by: staff.id });
    audit(db, staff.id, 'API_CLIENT_CREATE', 'api_clients', id, { name: body.name, scopes: body.scopes });
    // The full key is shown once; only its hash is stored.
    res.status(201).json({ id, name: body.name, key, scopes: body.scopes });
  }));

  r.post('/integrations/clients/:id/revoke', wrap((req) => {
    const staff = requireRole(db, req, 'ADMIN');
    db.run('UPDATE api_clients SET active = 0 WHERE id = ?', Number(req.params.id));
    audit(db, staff.id, 'API_CLIENT_REVOKE', 'api_clients', Number(req.params.id));
    return { ok: true };
  }));

  return r;
}
