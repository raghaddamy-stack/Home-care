// Tax on invoices and e-invoicing (JoFotara and the mock), all driven by owner settings.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';
import { processEInvoiceQueue, submitEInvoice } from '../src/einvoice/service.js';

const ADMIN = 1, AGENT = 2, COORD = 3, DOCTOR = 4, LAB = 8, FINANCE = 11;
const HOME = { lat: 31.9539, lng: 35.9106 };
const CONSENT = { signedBy: 'Patient', relation: 'SELF', method: 'ESIGN' };
const patient = {
  nationalId: '9861110000', fullName: 'Lama Haddad', dob: '1980-01-01', gender: 'F' as const, phone: '0790000010',
  address: 'Amman', ...HOME, zoneId: 1, emergencyContact: 'Husband 0791111111',
};
const SELLER = { sellerTin: '12345678', sellerName: 'Demo Home Care LLC', incomeSourceSequence: '9876543' };

let app: ReturnType<typeof createApp>;
let db: Db;
const post = (url: string, body: object, staffId?: number, at?: string) => {
  const r = request(app).post(url);
  if (staffId) r.set('x-staff-id', String(staffId));
  if (at) r.set('x-now', at);
  return r.send(body);
};
const setSettings = async (patch: object) => {
  const r = await request(app).put('/api/settings').set('x-staff-id', String(ADMIN)).send(patch);
  expect(r.status).toBe(200);
  return r;
};

beforeEach(() => {
  db = new Db(':memory:');
  seed(db);
  app = createApp(db);
});

/** A completed, paid direct visit. Returns the invoice id. */
async function paidVisit(code: string, staffId: number) {
  const { body } = await post('/api/requests', { channel: 'CALL_CENTER', patient, items: [{ serviceCode: code }] }, AGENT);
  await post(`/api/requests/${body.id}/quote`, { scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
  await post(`/api/requests/${body.id}/accept`, {}, COORD);
  const s = await post(`/api/requests/${body.id}/schedule`, { route: 'DIRECT', staffId, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
  await post(`/api/visits/${s.body.visitId}/dispatch`, {}, staffId);
  await post(`/api/visits/${s.body.visitId}/check-in`, { ...HOME, consent: CONSENT }, staffId, '2026-11-12T08:00:00Z');
  const done = await post(`/api/visits/${s.body.visitId}/complete`, { result: code.startsWith('LAB') ? { report: 'normal' } : undefined, payment: { method: 'CASH', amount: 1_000_000 } }, staffId, '2026-11-12T08:30:00Z');
  expect(done.status).toBe(200);
  return done.body.invoiceId as number;
}

describe('tax on invoices', () => {
  it('exempt medical services carry no tax; prices that include tax keep the same total', async () => {
    const id = await paidVisit('DOC-VISIT', DOCTOR);
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', id)!;
    expect([inv.total, inv.tax_total, inv.subtotal]).toEqual([35_000, 0, 35_000]);
    expect(db.get('SELECT tax_category, tax_rate FROM invoice_lines WHERE invoice_id = ?', id)).toEqual({ tax_category: 'O', tax_rate: 0 });
  });

  it('a 16% standard-rated line extracts the tax from an inclusive price', async () => {
    const rules = (await request(app).get('/api/settings').set('x-staff-id', String(ADMIN))).body.values.taxRules;
    await setSettings({ taxRules: { ...rules, DOC: { category: 'S', rate: 16 } } });
    const id = await paidVisit('DOC-VISIT', DOCTOR);
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', id)!;
    expect(inv.total).toBe(35_000);
    expect(inv.subtotal).toBe(Math.round(35_000 * 100 / 116));
    expect(inv.tax_total).toBe(35_000 - inv.subtotal);
  });

  it('tax added on top when prices exclude it, and the patient pays the gross amount', async () => {
    const rules = (await request(app).get('/api/settings').set('x-staff-id', String(ADMIN))).body.values.taxRules;
    await setSettings({ pricesIncludeTax: false, taxRules: { ...rules, DOC: { category: 'S', rate: 16 } } });
    const id = await paidVisit('DOC-VISIT', DOCTOR);
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', id)!;
    expect([inv.subtotal, inv.tax_total, inv.total, inv.patient_total]).toEqual([35_000, 5_600, 40_600, 40_600]);
  });

  it('rejects inconsistent tax rules', async () => {
    const rules = (await request(app).get('/api/settings').set('x-staff-id', String(ADMIN))).body.values.taxRules;
    const bad = await request(app).put('/api/settings').set('x-staff-id', String(ADMIN)).send({ taxRules: { ...rules, LAB: { category: 'O', rate: 16 } } });
    expect(bad.status).toBe(400);
  });
});

describe('e-invoicing', () => {
  it('stays off by default and refuses to send until the seller setup is complete', async () => {
    const id = await paidVisit('LAB-CBC', LAB);
    expect(db.get('SELECT COUNT(*) AS n FROM einvoices')!.n).toBe(0);
    await setSettings({ einvoiceProvider: 'MOCK' });
    const r = await post(`/api/invoices/${id}/einvoice`, {}, FINANCE);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/الرقم الضريبي/);
  });

  it('mock: queued on issue, accepted with a QR, and the printable document carries it', async () => {
    await setSettings({ einvoiceProvider: 'MOCK', ...SELLER });
    const id = await paidVisit('LAB-CBC', LAB);
    expect(db.get('SELECT status FROM einvoices WHERE invoice_id = ?', id)!.status).toBe('PENDING');
    expect(await processEInvoiceQueue(db)).toBe(1);
    const e = db.get('SELECT * FROM einvoices WHERE invoice_id = ?', id)!;
    expect(e.status).toBe('ACCEPTED');
    expect(e.qr.length).toBeGreaterThan(40);
    expect(e.xml).toContain('<cbc:CompanyID>12345678</cbc:CompanyID>');
    expect(e.xml).toContain('<cbc:InvoiceTypeCode name="011">388</cbc:InvoiceTypeCode>'); // paid at the door → cash
    expect(e.xml).toContain('<cbc:ID>ICV</cbc:ID>');
    expect(e.xml).toContain('<cbc:ID>9876543</cbc:ID>');
    const doc = await request(app).get(`/api/invoices/${id}/document`).set('x-staff-id', String(FINANCE));
    expect(doc.body.einvoice.qrSvg).toMatch(/^<svg/);
    expect(doc.body.seller.tin).toBe('12345678');
    // The ERP outbox recorded the issue and the acceptance.
    expect(db.all('SELECT event FROM webhook_events ORDER BY id').map((x: any) => x.event)).toEqual(
      expect.arrayContaining(['invoice.issued', 'payment.created', 'invoice.paid', 'einvoice.accepted']));
  });

  it('JoFotara: sends base64 UBL with Client-Id / Secret-Key, stores the returned QR', async () => {
    await setSettings({ einvoiceProvider: 'JOFOTARA', einvoiceClientId: 'client-abc', einvoiceSecretKey: 'secret-xyz', einvoiceAutoSubmit: false, ...SELLER });
    const id = await paidVisit('LAB-CBC', LAB);
    const calls: { url: string; headers: any; xml: string }[] = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, headers: init.headers, xml: Buffer.from(JSON.parse(init.body).invoice, 'base64').toString('utf8') });
      return new Response(JSON.stringify({ EINV_STATUS: 'SUBMITTED', EINV_QR: 'QRDATA123', EINV_NUM: '7001', EINV_INV_UUID: 'x' }), { status: 200 });
    }) as unknown as typeof fetch;
    const { queueEInvoice } = await import('../src/einvoice/service.js');
    const e = queueEInvoice(db, id);
    const out = await submitEInvoice(db, e.id, fake);
    expect(out.status).toBe('ACCEPTED');
    expect(out.qr).toBe('QRDATA123');
    expect(calls[0].url).toBe('https://backend.jofotara.gov.jo/core/invoices/');
    expect(calls[0].headers['Client-Id']).toBe('client-abc');
    expect(calls[0].headers['Secret-Key']).toBe('secret-xyz');
    expect(calls[0].xml).toContain('<cbc:ProfileID>reporting:1.0</cbc:ProfileID>');
  });

  it('JoFotara: a validation error is a rejection; an outage is retried later', async () => {
    await setSettings({ einvoiceProvider: 'JOFOTARA', einvoiceClientId: 'c', einvoiceSecretKey: 's', einvoiceAutoSubmit: false, ...SELLER });
    const { queueEInvoice } = await import('../src/einvoice/service.js');
    const a = queueEInvoice(db, await paidVisit('LAB-CBC', LAB));
    const rejected = await submitEInvoice(db, a.id, (async () => new Response(JSON.stringify({ EINV_MESSAGE: 'Invalid buyer ID' }), { status: 400 })) as unknown as typeof fetch);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.message).toMatch(/Invalid buyer ID/);
    const b = queueEInvoice(db, await paidVisit('LAB-HBA1C', LAB));
    const down = await submitEInvoice(db, b.id, (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch);
    expect(down.status).toBe('FAILED');
    expect(down.next_attempt_at).toBeTruthy();
  });

  it('keeps credentials encrypted at rest and never returns them', async () => {
    await setSettings({ einvoiceClientId: 'client-abc', einvoiceSecretKey: 'secret-xyz' });
    const raw = db.get(`SELECT value FROM settings WHERE key = 'einvoiceSecretKey'`)!.value;
    expect(raw).not.toContain('secret-xyz');
    const got = await request(app).get('/api/settings').set('x-staff-id', String(ADMIN));
    expect(got.body.values.einvoiceSecretKey).toEqual({ set: true, last4: '-xyz' });
    expect(JSON.stringify(got.body)).not.toContain('secret-xyz');
    // Still usable after a restart (decrypted on load).
    app = createApp(db);
    const again = await request(app).get('/api/settings').set('x-staff-id', String(ADMIN));
    expect(again.body.values.einvoiceSecretKey.set).toBe(true);
  });
});
