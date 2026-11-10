// ERP API: API keys and scopes, invoice export with tax and e-invoice data, payments from the ERP, events, webhooks.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';
import { processEInvoiceQueue } from '../src/einvoice/service.js';
import { deliverWebhooks, sign } from '../src/webhooks.js';

const ADMIN = 1, AGENT = 2, COORD = 3, DOCTOR = 4, FINANCE = 11;
const HOME = { lat: 31.9539, lng: 35.9106 };
const CONSENT = { signedBy: 'Patient', relation: 'SELF', method: 'ESIGN' };
const patient = {
  nationalId: '9871112222', fullName: 'Omar Zaid', dob: '1975-01-01', gender: 'M' as const, phone: '0790000011',
  address: 'Amman', ...HOME, zoneId: 1, emergencyContact: 'Wife 0791111111',
};

let app: ReturnType<typeof createApp>;
let db: Db;
const post = (url: string, body: object, staffId?: number) => {
  const r = request(app).post(url);
  if (staffId) r.set('x-staff-id', String(staffId));
  return r.send(body);
};
const admin = (method: 'get' | 'put' | 'post', url: string, body?: object) => request(app)[method](url).set('x-staff-id', String(ADMIN)).send(body);

beforeEach(() => {
  db = new Db(':memory:');
  seed(db);
  app = createApp(db);
});

async function newKey(scopes: string[]) {
  const r = await admin('post', '/api/integrations/clients', { name: 'SAP S/4HANA', scopes });
  expect(r.status).toBe(201);
  return r.body.key as string;
}

/** Doctor visit completed and invoiced, paid `paid` fils at the door. */
async function invoicedVisit(paid?: number) {
  const { body } = await post('/api/requests', { channel: 'CALL_CENTER', patient, items: [{ serviceCode: 'DOC-VISIT' }] }, AGENT);
  await post(`/api/requests/${body.id}/quote`, { scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
  await post(`/api/requests/${body.id}/accept`, {}, COORD);
  const s = await post(`/api/requests/${body.id}/schedule`, { route: 'DIRECT', staffId: DOCTOR, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
  await post(`/api/visits/${s.body.visitId}/dispatch`, {}, DOCTOR);
  await post(`/api/visits/${s.body.visitId}/check-in`, { ...HOME, consent: CONSENT }, DOCTOR);
  const done = await post(`/api/visits/${s.body.visitId}/complete`, paid ? { payment: { method: 'CASH', amount: paid } } : {}, DOCTOR);
  return done.body.invoiceId as number;
}

describe('API keys', () => {
  it('only the owner creates keys; keys are hashed, scoped and revocable', async () => {
    expect((await post('/api/integrations/clients', { name: 'x', scopes: ['invoices:read'] }, FINANCE)).status).toBe(403);
    const key = await newKey(['invoices:read']);
    expect(key).toMatch(/^hc_/);
    expect(JSON.stringify(db.all('SELECT * FROM api_clients'))).not.toContain(key);

    expect((await request(app).get('/api/erp/v1/invoices')).status).toBe(401);
    expect((await request(app).get('/api/erp/v1/invoices').set('Authorization', `Bearer ${key}`)).status).toBe(200);
    expect((await request(app).get('/api/erp/v1/payments').set('X-API-Key', key)).status).toBe(403); // no payments:read

    const id = db.get('SELECT id FROM api_clients')!.id;
    await admin('post', `/api/integrations/clients/${id}/revoke`);
    expect((await request(app).get('/api/erp/v1/invoices').set('Authorization', `Bearer ${key}`)).status).toBe(401);
  });

  it('publishes an OpenAPI description without a key', async () => {
    const r = await request(app).get('/api/erp/v1/openapi.json');
    expect(r.body.openapi).toBe('3.0.3');
    expect(Object.keys(r.body.paths)).toContain('/invoices/{id}/ack');
  });
});

describe('invoice export', () => {
  it('returns issued invoices with tax, G/L mapping, customer and e-invoice data; supports unsynced + ack', async () => {
    await admin('put', '/api/settings', {
      einvoiceProvider: 'MOCK', sellerTin: '111', sellerName: 'Demo LLC', incomeSourceSequence: '222',
      erpGlAccounts: { LAB: '400100', IMG: '400200', DEV: '400300', DOC: '400400', NRS: '400500', FEE: '400900' },
      erpTaxCodes: { S: 'A1', Z: 'A0', O: 'O1' }, erpCostCenter: 'HC-AMM',
    });
    const id = await invoicedVisit(35_000);
    await processEInvoiceQueue(db);
    const key = await newKey(['invoices:read', 'invoices:ack', 'customers:write']);
    const auth = { Authorization: `Bearer ${key}` };

    const list = await request(app).get('/api/erp/v1/invoices?unsynced=true').set(auth);
    expect(list.body.data).toHaveLength(1);
    const inv = list.body.data[0];
    expect(inv.number).toMatch(/^INV-/);
    expect(inv.totals.gross).toEqual({ amount: '35.000', fils: 35_000 });
    expect(inv.status).toBe('PAID');
    expect(inv.costCenter).toBe('HC-AMM');
    expect(inv.lines[0]).toMatchObject({ serviceCode: 'DOC-VISIT', glAccount: '400400', tax: { category: 'O', rate: 0, erpTaxCode: 'O1' } });
    expect(inv.eInvoice.status).toBe('ACCEPTED');
    expect(inv.eInvoice.qr).toBeTruthy();
    expect(inv.customer.nationalId).toBe('9871112222');

    // The ERP stores its own customer number and confirms posting.
    await request(app).put(`/api/erp/v1/customers/${inv.customer.id}`).set(auth).send({ erpCode: 'BP-100045' });
    await request(app).post(`/api/erp/v1/invoices/${id}/ack`).set(auth).send({ erpDocumentNo: '1800000123' });
    expect((await request(app).get('/api/erp/v1/invoices?unsynced=true').set(auth)).body.data).toHaveLength(0);
    const one = await request(app).get(`/api/erp/v1/invoices/${inv.number}`).set(auth);
    expect(one.body.erp.documentNo).toBe('1800000123');
    expect(one.body.customer.erpCode).toBe('BP-100045');
    const svg = await request(app).get(`/api/erp/v1/invoices/${id}/qr.svg`).set(auth).buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c: Buffer) => (d += c)); res.on('end', () => cb(null, d)); });
    expect(svg.headers['content-type']).toMatch(/svg/);
    expect(svg.body).toMatch(/^<svg/);
  });

  it('pages with a cursor without missing or repeating invoices', async () => {
    for (let i = 0; i < 3; i++) await invoicedVisit();
    const key = await newKey(['invoices:read']);
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const r: any = await request(app).get(`/api/erp/v1/invoices?limit=2${cursor ? `&cursor=${cursor}` : ''}`).set('X-API-Key', key);
      seen.push(...r.body.data.map((x: any) => x.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });
});

describe('payments from the ERP', () => {
  it('records a bank transfer once per Idempotency-Key and marks the invoice paid', async () => {
    const id = await invoicedVisit();
    const key = await newKey(['payments:write', 'payments:read', 'events:read']);
    const send = () => request(app).post('/api/erp/v1/payments').set('Authorization', `Bearer ${key}`).set('Idempotency-Key', 'sap-pay-0001')
      .send({ invoiceId: id, amount: '35.000', method: 'TRANSFER', reference: 'SAP 1400000077' });
    const a = await send();
    const b = await send();
    expect(a.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(a.body.invoiceStatus).toBe('PAID');
    expect(db.get('SELECT COUNT(*) AS n FROM payments WHERE invoice_id = ?', id)!.n).toBe(1);
    expect((await request(app).post('/api/erp/v1/payments').set('X-API-Key', key).send({ invoiceId: id, amount: '1.000' })).status).toBe(400);

    const ev = await request(app).get('/api/erp/v1/events?afterId=0').set('X-API-Key', key);
    const names = ev.body.data.map((e: any) => e.event);
    expect(names).toEqual(expect.arrayContaining(['invoice.issued', 'payment.created', 'invoice.paid']));
    expect(ev.body.data.find((e: any) => e.event === 'payment.created').data.source).toBe('ERP');
  });
});

describe('webhooks', () => {
  it('delivers signed events and retries failures with back-off', async () => {
    await admin('put', '/api/settings', { erpWebhookUrl: 'https://erp.example.com/hooks/home-care', erpWebhookSecret: 'whsec_123' });
    await invoicedVisit(35_000);
    const got: { headers: any; body: string }[] = [];
    let fail = true;
    const fake = (async (_url: string, init: any) => {
      got.push({ headers: init.headers, body: init.body });
      return new Response('', { status: fail ? 503 : 200 });
    }) as unknown as typeof fetch;

    const first = await deliverWebhooks(db, fake);
    expect(first.failed).toBeGreaterThan(0);
    db.run(`UPDATE webhook_events SET next_attempt_at = NULL`);
    fail = false;
    const second = await deliverWebhooks(db, fake);
    expect(second.sent).toBe(first.failed);
    const last = got[got.length - 1];
    expect(last.headers['x-hc-signature']).toBe(sign(last.body, 'whsec_123'));
    expect(JSON.parse(last.body).event).toBeTruthy();
  });
});
