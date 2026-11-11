// ERP stock: availability is checked before anything is dispensed, and every dispense becomes a goods issue.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';
import { checkStock, processStockQueue } from '../src/stock.js';

const ADMIN = 1, AGENT = 2, COORD = 3, DOCTOR = 4, DRIVER = 10, PHARM = 13;
const HOME = { lat: 31.9539, lng: 35.9106 };
const CONSENT = { signedBy: 'Family', relation: 'SELF', method: 'ESIGN' };
let app: ReturnType<typeof createApp>;
let db: Db;

const call = (method: 'get' | 'post' | 'put', url: string, body: object | undefined, staffId: number, at?: string) => {
  const r = request(app)[method](url).set('x-staff-id', String(staffId));
  if (at) r.set('x-now', at);
  return body ? r.send(body) : r;
};
const ok = async (p: PromiseLike<request.Response>) => { const r = await p; if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const settings = (patch: object) => ok(call('put', '/api/settings', patch, ADMIN));

beforeEach(() => {
  db = new Db(':memory:');
  seed(db);
  app = createApp(db);
});

async function episodeWithOrder(code: string) {
  const req = await ok(call('post', '/api/requests', { channel: 'CALL_CENTER', patient: { nationalId: '9870000777', fullName: 'Stock Patient', dob: '1950-01-01', gender: 'M', phone: '0790000777', address: 'Amman', ...HOME, zoneId: 1, emergencyContact: 'Son' }, items: [{ serviceCode: 'NRS-HOUR' }] }, AGENT));
  await ok(call('post', `/api/requests/${req.id}/quote`, {}, COORD));
  await ok(call('post', `/api/requests/${req.id}/accept`, { evidence: 'phone' }, COORD));
  const v = await ok(call('post', `/api/requests/${req.id}/schedule`, { route: 'ASSESSMENT', staffId: DOCTOR, scheduledAt: '2026-11-12T08:00:00Z' }, COORD));
  await ok(call('post', `/api/visits/${v.visitId}/dispatch`, {}, DOCTOR));
  await ok(call('post', `/api/visits/${v.visitId}/check-in`, { ...HOME, consent: CONSENT }, DOCTOR));
  const ep = await ok(call('post', '/api/episodes', { requestId: req.id, diagnosis: 'COPD', suitable: true }, DOCTOR));
  const order = await ok(call('post', `/api/episodes/${ep.id}/orders`, { serviceCode: code }, DOCTOR));
  return { ep, order };
}

describe('ERP stock', () => {
  it('is off by default: dispensing works without any check or goods issue', async () => {
    const { order } = await episodeWithOrder('PHA-DELIVERY');
    await ok(call('post', `/api/orders/${order.id}/result`, { report: 'Delivered' }, PHARM));
    expect(db.get('SELECT COUNT(*) AS n FROM stock_movements')!.n).toBe(0);
  });

  it('mock: checks the mapped material, blocks when short, posts the goods issue and reduces the stock', async () => {
    await settings({ stockProvider: 'MOCK', stockMaterials: { 'DEV-O2': 'MAT-O2-CONC', 'PHA-DELIVERY': 'MAT-MED-PACK' } });
    const pre = await ok(call('post', '/api/stock/check', { serviceCode: 'DEV-O2' }, DRIVER));
    expect(pre.lines[0]).toMatchObject({ material: 'MAT-O2-CONC', available: 3, enough: true });

    const { order } = await episodeWithOrder('DEV-O2');
    await ok(call('post', `/api/orders/${order.id}/result`, { report: 'Installed', serialNo: 'O2-1' }, DRIVER));
    expect(db.get('SELECT * FROM stock_movements')).toMatchObject({ material: 'MAT-O2-CONC', qty: 1, status: 'PENDING', reference: `ORDER-${order.id}` });
    expect(await processStockQueue(db)).toEqual({ posted: 1, failed: 0 });
    expect(db.get(`SELECT available FROM stock_mock WHERE material = 'MAT-O2-CONC'`)!.available).toBe(2);

    // Out of stock → blocked (default policy), nothing dispensed.
    await ok(call('put', '/api/stock/mock', { material: 'MAT-MED-PACK', available: 0 }, ADMIN));
    const med = await ok(call('post', `/api/episodes/${order.id ? (await ok(call('get', '/api/episodes', undefined, COORD)))[0].id : 0}/orders`, { serviceCode: 'PHA-DELIVERY' }, DOCTOR));
    const blocked = await call('post', `/api/orders/${med.id}/result`, { report: 'Delivered' }, PHARM);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Not enough stock of MAT-MED-PACK/);
    expect(db.get('SELECT status FROM orders WHERE id = ?', med.id)!.status).toBe('PLACED');

    // Policy WARN: dispensed with a warning.
    await settings({ stockMode: 'WARN' });
    const warned = await ok(call('post', `/api/orders/${med.id}/result`, { report: 'Delivered from the car stock' }, PHARM));
    expect(warned.stockWarnings[0]).toMatch(/MAT-MED-PACK/);
  });

  it('the pharmacist can list the exact materials dispensed', async () => {
    await settings({ stockProvider: 'MOCK' });
    const { order } = await episodeWithOrder('PHA-DELIVERY');
    await ok(call('post', `/api/orders/${order.id}/result`, { report: 'Antibiotic course', stockItems: [{ material: 'MAT-MED-PACK', qty: 3 }, { material: 'MAT-LAB-KIT', qty: 1 }] }, PHARM));
    expect(db.all('SELECT material, qty FROM stock_movements ORDER BY id')).toEqual([{ material: 'MAT-MED-PACK', qty: 3 }, { material: 'MAT-LAB-KIT', qty: 1 }]);
  });

  it('direct device delivery checks one unit (not rental days) before the visit is completed', async () => {
    await settings({ stockProvider: 'MOCK', stockMaterials: { 'DEV-BED': 'MAT-BED-ELEC' } });
    await ok(call('put', '/api/stock/mock', { material: 'MAT-BED-ELEC', available: 0 }, ADMIN));
    const req = await ok(call('post', '/api/requests', { channel: 'CALL_CENTER', patient: { nationalId: '9870000888', fullName: 'Bed Patient', dob: '1950-01-01', gender: 'F', phone: '0790000888', address: 'Amman', ...HOME, zoneId: 1, emergencyContact: 'Son' }, items: [{ serviceCode: 'DEV-BED', qty: 14 }] }, AGENT));
    await ok(call('post', `/api/requests/${req.id}/quote`, { scheduledAt: '2026-11-12T08:00:00Z' }, COORD));
    await ok(call('post', `/api/requests/${req.id}/accept`, { evidence: 'phone' }, COORD));
    const v = await ok(call('post', `/api/requests/${req.id}/schedule`, { route: 'DIRECT', staffId: DRIVER, scheduledAt: '2026-11-12T08:00:00Z' }, COORD));
    await ok(call('post', `/api/visits/${v.visitId}/dispatch`, {}, DRIVER));
    await ok(call('post', `/api/visits/${v.visitId}/check-in`, { ...HOME, consent: CONSENT }, DRIVER));
    const body = { rental: { serialNo: 'BED-9', expectedReturn: '2026-11-26', handoverSigned: true } };
    expect((await call('post', `/api/visits/${v.visitId}/complete`, body, DRIVER)).status).toBe(409);
    await ok(call('put', '/api/stock/mock', { material: 'MAT-BED-ELEC', available: 1 }, ADMIN));
    await ok(call('post', `/api/visits/${v.visitId}/complete`, body, DRIVER));
    expect(db.get('SELECT material, qty FROM stock_movements')).toEqual({ material: 'MAT-BED-ELEC', qty: 1 });
  });

  it('SAP: reads unrestricted stock and posts a goods-issue material document with a CSRF token', async () => {
    await settings({ stockProvider: 'SAP', stockBaseUrl: 'https://s4.example.com', stockUser: 'HC_API', stockApiKey: 'pw', stockPlant: '1000', stockLocation: '0001', erpCostCenter: 'HC-AMM' });
    const calls: { url: string; init: any }[] = [];
    const fake = (async (url: string, init: any = {}) => {
      calls.push({ url, init });
      if (url.includes('API_MATERIAL_STOCK_SRV')) return new Response(JSON.stringify({ d: { results: [{ MatlWrhsStkQtyInMatlBaseUnit: '4' }, { MatlWrhsStkQtyInMatlBaseUnit: '1' }] } }), { status: 200 });
      if (init.method !== 'POST') return new Response('', { status: 200, headers: { 'x-csrf-token': 'tok123', 'set-cookie': 'SAP_SESSIONID=abc; path=/' } });
      return new Response(JSON.stringify({ d: { MaterialDocument: '4900001234' } }), { status: 201 });
    }) as unknown as typeof fetch;

    const c = await checkStock(db, [{ material: 'MAT-O2-CONC', qty: 2 }], fake);
    expect(c.lines[0]).toMatchObject({ available: 5, enough: true });
    expect(decodeURIComponent(calls[0].url)).toContain("Material eq 'MAT-O2-CONC' and Plant eq '1000' and StorageLocation eq '0001'");
    expect(calls[0].init.headers.Authorization).toBe('Basic ' + Buffer.from('HC_API:pw').toString('base64'));

    db.insert('stock_movements', { reference: 'ORDER-1', material: 'MAT-O2-CONC', qty: 1 });
    expect(await processStockQueue(db, fake)).toEqual({ posted: 1, failed: 0 });
    const post = calls.find((x) => x.init.method === 'POST')!;
    expect(post.init.headers['x-csrf-token']).toBe('tok123');
    expect(JSON.parse(post.init.body)).toMatchObject({ GoodsMovementCode: '03', to_MaterialDocumentItem: { results: [{ Material: 'MAT-O2-CONC', Plant: '1000', StorageLocation: '0001', GoodsMovementType: '201', CostCenter: 'HC-AMM' }] } });
    expect(db.get('SELECT erp_document FROM stock_movements')!.erp_document).toBe('4900001234');
  });

  it('ERP down: allowed by default (posted later), or blocked when the owner says so', async () => {
    await settings({ stockProvider: 'GENERIC', stockBaseUrl: 'https://erp.invalid', stockMaterials: { 'PHA-DELIVERY': 'MAT-MED-PACK' } });
    const { order } = await episodeWithOrder('PHA-DELIVERY');
    const allowed = await ok(call('post', `/api/orders/${order.id}/result`, { report: 'Delivered' }, PHARM));
    expect(allowed.stockWarnings[0]).toMatch(/not checked/);
    expect(db.get('SELECT status FROM stock_movements')!.status).toBe('PENDING');
    await settings({ stockOnError: 'BLOCK' });
    const ep = (await ok(call('get', '/api/episodes', undefined, COORD)))[0];
    const again = await ok(call('post', `/api/episodes/${ep.id}/orders`, { serviceCode: 'PHA-DELIVERY' }, DOCTOR));
    expect((await call('post', `/api/orders/${again.id}/result`, { report: 'Delivered' }, PHARM)).status).toBe(503);
  });
});
