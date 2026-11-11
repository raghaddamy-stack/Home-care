// Full business cycles, start to finish, checking that every link is connected and every path ends closed:
// clinical work → departments → devices → billing → tax e-invoice → payments (patient and insurer) → ERP → account closure.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';
import { processEInvoiceQueue } from '../src/einvoice/service.js';

const ADMIN = 1, AGENT = 2, COORD = 3, DOCTOR = 4, RANA = 5, LAB = 8, RADIO = 9, DRIVER = 10, FINANCE = 11, PHARM = 13;
const HOME = { lat: 31.9539, lng: 35.9106 };
const CONSENT = { signedBy: 'Family member', relation: 'SELF', method: 'ESIGN' };

let app: ReturnType<typeof createApp>;
let db: Db;
let erpKey = '';

const call = (method: 'get' | 'post' | 'put', url: string, body: object | undefined, staffId: number, at?: string) => {
  const r = request(app)[method](url).set('x-staff-id', String(staffId));
  if (at) r.set('x-now', at);
  return body ? r.send(body) : r;
};
async function ok(p: PromiseLike<request.Response>, status = [200, 201]) {
  const r = await p;
  if (!status.includes(r.status)) throw new Error(`${(r as any).req?.method} ${(r as any).req?.path} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const post = (url: string, body: object, staffId: number, at?: string) => ok(call('post', url, body, staffId, at));
const get = (url: string, staffId: number, at?: string) => ok(call('get', url, undefined, staffId, at));
const erp = (method: 'get' | 'post', url: string, body?: object, idem?: string) => {
  const r = request(app)[method](`/api/erp/v1${url}`).set('Authorization', `Bearer ${erpKey}`);
  if (idem) r.set('Idempotency-Key', idem);
  return ok(body ? r.send(body) : r);
};

beforeEach(async () => {
  db = new Db(':memory:');
  seed(db);
  app = createApp(db);
  await ok(call('put', '/api/settings', { einvoiceProvider: 'MOCK', sellerTin: '12345678', sellerName: 'Demo Home Care', incomeSourceSequence: '555' }, ADMIN));
  erpKey = (await post('/api/integrations/clients', { name: 'SAP', scopes: ['invoices:read', 'invoices:ack', 'payments:read', 'payments:write', 'events:read'] }, ADMIN)).key;
});

function patient(nid: string) {
  return { nationalId: nid, fullName: `Patient ${nid.slice(-3)}`, dob: '1950-01-01', gender: 'M' as const, phone: `079${nid.slice(-7)}`, address: 'Amman', ...HOME, zoneId: 1, emergencyContact: 'Son 0791111111' };
}

describe('cycle 1 · home care, insured: assessment → orders → device → shifts → hold/resume → billing → insurer → discharge → closure', () => {
  it('closes every loop', async () => {
    // Intake with insurance; the insurer covers nursing hours and the lab panel (20% co-pay), not pharmacy.
    const req = await post('/api/requests', { channel: 'CALL_CENTER', patient: patient('9800000001'), items: [{ serviceCode: 'NRS-HOUR', qty: 1 }], insurance: { payerId: 2, memberNo: 'GOLD-1' } }, AGENT, '2026-11-01T08:00:00Z');
    db.run(`UPDATE insurance_policies SET covered_codes = '["NRS-HOUR","LAB-PANEL"]', copay_pct = 20`);
    expect((await post(`/api/requests/${req.id}/quote`, {}, COORD, '2026-11-01T08:10:00Z')).status).toBe('PENDING_PREAPPROVAL');
    await post(`/api/requests/${req.id}/quote`, { preApprovalNo: 'PA-1' }, COORD, '2026-11-01T09:00:00Z');
    await post(`/api/requests/${req.id}/accept`, { evidence: 'phone' }, COORD, '2026-11-01T09:10:00Z');

    // Assessment visit → episode.
    const v = await post(`/api/requests/${req.id}/schedule`, { route: 'ASSESSMENT', staffId: DOCTOR, scheduledAt: '2026-11-01T12:00:00Z' }, COORD, '2026-11-01T09:20:00Z');
    await post(`/api/visits/${v.visitId}/dispatch`, {}, DOCTOR, '2026-11-01T11:30:00Z');
    await post(`/api/visits/${v.visitId}/check-in`, { ...HOME, consent: CONSENT }, DOCTOR, '2026-11-01T12:00:00Z');
    const ep = await post('/api/episodes', { requestId: req.id, diagnosis: 'Post-stroke', suitable: true, billingCycle: 'WEEKLY' }, DOCTOR, '2026-11-01T12:30:00Z');
    await post(`/api/episodes/${ep.id}/care-plan`, { shiftHours: 8, hoursPerDay: 8, durationDays: 3 }, DOCTOR, '2026-11-01T12:40:00Z');

    // Orders go to each department and come back.
    const lab = await post(`/api/episodes/${ep.id}/orders`, { serviceCode: 'LAB-PANEL' }, DOCTOR, '2026-11-02T06:00:00Z');
    const o2 = await post(`/api/episodes/${ep.id}/orders`, { serviceCode: 'DEV-O2' }, DOCTOR, '2026-11-02T06:00:00Z');
    const med = await post(`/api/episodes/${ep.id}/orders`, { serviceCode: 'PHA-DELIVERY' }, DOCTOR, '2026-11-02T06:00:00Z');
    expect([lab.department, o2.department, med.department]).toEqual(['LAB', 'EQUIPMENT', 'PHARMACY']);
    await post(`/api/orders/${lab.id}/accept`, {}, LAB, '2026-11-02T06:10:00Z');
    const labRes = await post(`/api/orders/${lab.id}/result`, { report: 'Panel normal' }, LAB, '2026-11-02T10:00:00Z');
    await post(`/api/results/${labRes.id}/acknowledge`, {}, DOCTOR, '2026-11-02T11:00:00Z');
    await post(`/api/orders/${o2.id}/result`, { report: 'Delivered and installed', serialNo: 'O2-7781' }, DRIVER, '2026-11-02T09:00:00Z');
    await post(`/api/orders/${med.id}/result`, { report: 'Medications delivered' }, PHARM, '2026-11-02T09:30:00Z');
    const rentals = await get('/api/rentals?status=ACTIVE', COORD);
    expect(rentals).toHaveLength(1);
    expect(rentals[0]).toMatchObject({ episode_id: ep.id, serial_no: 'O2-7781', service_code: 'DEV-O2' });

    // Roster: three 8 h shifts from Monday 2 Nov.
    const roster = await post(`/api/episodes/${ep.id}/roster`, { start: '2026-11-02T07:00:00Z', nurseIds: [RANA] }, COORD, '2026-11-01T13:00:00Z');
    const [s1, s2, s3] = roster.ids as number[];
    await post(`/api/shifts/${s1}/check-in`, HOME, RANA, '2026-11-02T07:00:00Z');
    await post(`/api/shifts/${s1}/check-out`, { handover: 'Stable day, oxygen in use' }, RANA, '2026-11-02T15:00:00Z');

    // Emergency on day 2 puts care on hold: no late alerts, no check-in until the doctor resumes.
    await post(`/api/shifts/${s2}/check-in`, HOME, RANA, '2026-11-03T07:00:00Z');
    const vit = await post(`/api/shifts/${s2}/vitals`, { respRate: 26, spo2: 90, onOxygen: true, systolicBp: 95, heartRate: 120, consciousness: 'A', temperature: 38.6 }, RANA, '2026-11-03T08:00:00Z');
    expect(vit.news2.band).toBe('HIGH');
    await post(`/api/shifts/${s2}/check-out`, { handover: 'Transferred to ER by ambulance' }, RANA, '2026-11-03T09:00:00Z');
    expect((await get(`/api/episodes/${ep.id}`, COORD)).status).toBe('ON_HOLD');
    expect((await post('/api/shifts/check-late', {}, COORD, '2026-11-04T07:30:00Z')).late).toEqual([]);
    expect((await call('post', `/api/shifts/${s3}/check-in`, HOME, RANA, '2026-11-04T07:00:00Z')).status).toBe(409);
    await post(`/api/episodes/${ep.id}/resume`, { note: 'Back home from ER, stable' }, DOCTOR, '2026-11-04T06:30:00Z');
    await post(`/api/shifts/${s3}/check-in`, HOME, RANA, '2026-11-04T07:00:00Z');
    await post(`/api/shifts/${s3}/check-out`, { handover: 'Stable, end of plan' }, RANA, '2026-11-04T15:00:00Z');

    // Weekly billing (Sat 31 Oct → Sat 7 Nov): shifts, lab + pharmacy orders, oxygen rental days; co-pay only on covered lines.
    await post(`/api/episodes/${ep.id}/discharge`, { summary: 'Plan completed, family trained' }, DOCTOR, '2026-11-05T10:00:00Z');
    const run = await post('/api/billing/run', { asOf: '2026-11-09T06:00:00Z' }, FINANCE);
    expect(run.created).toHaveLength(1);
    const weekly = await get(`/api/invoices/${run.created[0]}`, FINANCE);
    const types = weekly.lines.map((l: any) => l.source_type).sort();
    expect(types).toEqual(['ORDER', 'ORDER', 'RENTAL', 'SHIFT', 'SHIFT', 'SHIFT']);
    const pharmacy = weekly.lines.find((l: any) => l.service_code === 'PHA-DELIVERY');
    expect(pharmacy.patient_amount).toBe(pharmacy.amount); // not covered → patient pays all
    const panel = weekly.lines.find((l: any) => l.service_code === 'LAB-PANEL');
    expect(panel.patient_amount).toBe(Math.round(panel.amount * 0.2));
    expect(weekly.payer_total).toBeGreaterThan(0);

    // Issue → e-invoice → patient pays → insurer pays through the ERP.
    await post(`/api/invoices/${weekly.id}/issue`, {}, FINANCE, '2026-11-09T07:00:00Z');
    await post(`/api/invoices/${weekly.id}/payments`, { method: 'CLIQ', amount: weekly.patient_total }, FINANCE, '2026-11-09T08:00:00Z');
    await erp('post', '/payments', { invoiceId: weekly.id, amount: (weekly.payer_total / 1000).toFixed(3), method: 'INSURER', reference: 'Insurer batch 77' }, 'ins-77');
    expect(await get('/api/claims', FINANCE)).toEqual([]);

    // Discharged, but the account stays open until the oxygen concentrator is back.
    expect((await call('post', `/api/episodes/${ep.id}/final-invoice`, {}, FINANCE)).status).toBe(409);
    const ret = await post(`/api/rentals/${rentals[0].id}/return`, { condition: 'OK' }, DRIVER, '2026-11-10T09:00:00Z');
    expect(ret.status).toBe('RETURNED');
    const fin = await post(`/api/episodes/${ep.id}/final-invoice`, {}, FINANCE, '2026-11-10T10:00:00Z');
    const final = await get(`/api/invoices/${fin.invoiceId}`, FINANCE);
    expect(final.lines.map((l: any) => l.source_type)).toEqual(['RENTAL']); // the days after the weekly period
    expect((await get(`/api/episodes/${ep.id}`, COORD)).closed_at).toBeNull();
    await post(`/api/invoices/${final.id}/issue`, {}, FINANCE, '2026-11-10T10:05:00Z');
    await post(`/api/invoices/${final.id}/payments`, { method: 'CASH', amount: final.patient_total }, FINANCE, '2026-11-10T11:00:00Z');
    if (final.payer_total > 0) await post(`/api/invoices/${final.id}/payer-payments`, { amount: final.payer_total, reference: 'Insurer 78' }, FINANCE);

    // Closed: account, tax and ERP all agree.
    expect((await get(`/api/episodes/${ep.id}`, COORD)).closed_at).toBeTruthy();
    await processEInvoiceQueue(db);
    const einv = db.all('SELECT status FROM einvoices');
    expect(einv.length).toBe(2);
    expect(einv.every((e: any) => e.status === 'ACCEPTED')).toBe(true);
    const exported = (await erp('get', '/invoices')).data;
    expect(exported.map((x: any) => x.number).sort()).toEqual([final.invoice_no, weekly.invoice_no].sort());
    const events = (await erp('get', '/events')).data.map((e: any) => e.event);
    expect(events).toEqual(expect.arrayContaining(['invoice.issued', 'payment.created', 'payer_payment.created', 'invoice.paid', 'rental.returned', 'einvoice.accepted', 'episode.closed']));
  });
});

describe('cycle 2 · outpatient imaging: insurer refuses pre-approval → cash → scan → result later → paid → tax → ERP', () => {
  it('closes every loop', async () => {
    const req = await post('/api/requests', { channel: 'CALL_CENTER', patient: patient('9800000002'), items: [{ serviceCode: 'IMG-XRAY' }], prescriptionRef: 'RX-22', insurance: { payerId: 2, memberNo: 'SILVER-2' } }, AGENT);
    db.run(`UPDATE insurance_policies SET covered_codes = '["IMG-XRAY"]'`);
    expect((await post(`/api/requests/${req.id}/quote`, { scheduledAt: '2026-11-12T08:00:00Z' }, COORD)).status).toBe('PENDING_PREAPPROVAL');
    const cash = await post(`/api/requests/${req.id}/quote`, { asCash: true, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    expect([cash.total, cash.payerTotal, cash.patientTotal]).toEqual([60_000, 0, 60_000]);
    await post(`/api/requests/${req.id}/accept`, { evidence: 'phone' }, COORD);
    const v = await post(`/api/requests/${req.id}/schedule`, { route: 'DIRECT', staffId: RADIO, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/visits/${v.visitId}/dispatch`, {}, RADIO);
    await post(`/api/visits/${v.visitId}/check-in`, { ...HOME, consent: CONSENT }, RADIO);
    const done = await post(`/api/visits/${v.visitId}/complete`, { payment: { method: 'CARD', amount: 60_000 } }, RADIO);

    // The report is written later from the radiology worklist and reaches the patient's file.
    const work = await get('/api/orders?department=RADIOLOGY', RADIO);
    expect(work).toHaveLength(1);
    await post(`/api/orders/${work[0].id}/result`, { report: 'Chest X-ray: no consolidation' }, RADIO);
    const file = await get(`/api/patients/${req.patient_id}`, COORD);
    expect(file.results.map((r: any) => r.report)).toContain('Chest X-ray: no consolidation');

    await processEInvoiceQueue(db);
    const inv = await get(`/api/invoices/${done.invoiceId}`, FINANCE);
    expect(inv.status).toBe('PAID');
    expect(db.get('SELECT status FROM einvoices WHERE invoice_id = ?', inv.id)!.status).toBe('ACCEPTED');
    const exp = (await erp('get', `/invoices/${inv.id}`));
    await erp('post', `/invoices/${inv.id}/ack`, { erpDocumentNo: '1800000222' });
    expect(exp.payer).toMatchObject({ name: 'Demo Insurance Co.' });
    expect((await erp('get', '/invoices?unsynced=true')).data).toEqual([]);
  });
});

describe('cycle 3 · device rental: 7 days paid → extended → returned late and damaged → extra days + damage billed', () => {
  it('closes every loop', async () => {
    const req = await post('/api/requests', { channel: 'CALL_CENTER', patient: patient('9800000003'), items: [{ serviceCode: 'DEV-BED', qty: 7 }] }, AGENT);
    await post(`/api/requests/${req.id}/quote`, { scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/requests/${req.id}/accept`, { evidence: 'phone' }, COORD);
    const v = await post(`/api/requests/${req.id}/schedule`, { route: 'DIRECT', staffId: DRIVER, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/visits/${v.visitId}/dispatch`, {}, DRIVER, '2026-11-12T07:30:00Z');
    await post(`/api/visits/${v.visitId}/check-in`, { ...HOME, consent: CONSENT }, DRIVER, '2026-11-12T08:00:00Z');
    const done = await post(`/api/visits/${v.visitId}/complete`, {
      rental: { serialNo: 'BED-0042', expectedReturn: '2026-11-19', handoverSigned: true, deposit: 50_000 }, payment: { method: 'CASH', amount: 35_000 },
    }, DRIVER, '2026-11-12T08:30:00Z');
    expect(db.get('SELECT paid_days FROM rentals WHERE id = ?', done.rentalId)!.paid_days).toBe(7);

    await post(`/api/rentals/${done.rentalId}/extend`, { expectedReturn: '2026-11-22' }, COORD);
    const overdue = await get('/api/rentals?status=ACTIVE', COORD, '2026-11-23T08:00:00Z');
    expect(overdue[0]).toMatchObject({ overdue: true, pickupDue: true });

    const ret = await post(`/api/rentals/${done.rentalId}/return`, { condition: 'DAMAGED', damageCharge: 15_000, note: 'Broken side rail' }, DRIVER, '2026-11-22T08:30:00Z');
    expect(ret.daysUsed).toBe(10);
    expect(ret.extraDays).toBe(3);
    expect(ret.depositRefund).toBe(35_000);
    const extra = await get(`/api/invoices/${ret.invoiceId}`, FINANCE);
    expect(extra.status).toBe('ISSUED');
    expect(extra.total).toBe(3 * 5_000 + 15_000);
    await post(`/api/invoices/${extra.id}/payments`, { method: 'CASH', amount: extra.patient_total }, FINANCE);
    expect((await get(`/api/invoices/${extra.id}`, FINANCE)).status).toBe('PAID');
    expect((await call('post', `/api/rentals/${done.rentalId}/return`, {}, DRIVER)).status).toBe(409);
  });
});

describe('cycle 4 · wrong invoice: void → credit note to the tax system → corrected invoice', () => {
  it('closes every loop', async () => {
    const req = await post('/api/requests', { channel: 'CALL_CENTER', patient: patient('9800000004'), items: [{ serviceCode: 'DOC-VISIT' }] }, AGENT);
    await post(`/api/requests/${req.id}/quote`, { scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/requests/${req.id}/accept`, { evidence: 'phone' }, COORD);
    const v = await post(`/api/requests/${req.id}/schedule`, { route: 'DIRECT', staffId: DOCTOR, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/visits/${v.visitId}/dispatch`, {}, DOCTOR);
    await post(`/api/visits/${v.visitId}/check-in`, { ...HOME, consent: CONSENT }, DOCTOR);
    const done = await post(`/api/visits/${v.visitId}/complete`, {}, DOCTOR);
    await processEInvoiceQueue(db);

    const voided = await post(`/api/invoices/${done.invoiceId}/void`, { reason: 'Visit was charged to the wrong patient' }, FINANCE);
    expect(voided.creditNoteId).toBeTypeOf('number');
    const cn = await get(`/api/invoices/${voided.creditNoteId}`, FINANCE);
    expect(cn.total).toBe(-35_000);
    expect(cn.credit_for).toBe(done.invoiceId);
    await processEInvoiceQueue(db);
    const e = db.get('SELECT * FROM einvoices WHERE invoice_id = ?', cn.id)!;
    expect(e.type_code).toBe('381');
    expect(e.status).toBe('ACCEPTED');
    expect(e.xml).toContain('<cac:BillingReference>');
    expect((await get(`/api/invoices/${done.invoiceId}`, FINANCE)).status).toBe('VOID');
    // A paid invoice cannot be voided without a refund first.
    expect((await call('post', `/api/invoices/${cn.id}/void`, { reason: 'try again please' }, FINANCE)).status).toBe(409);
  });
});

describe('cycle 5 · late cancellation: fee draft → issued → paid', () => {
  it('closes every loop', async () => {
    const req = await post('/api/requests', { channel: 'CALL_CENTER', patient: patient('9800000005'), items: [{ serviceCode: 'DOC-VISIT' }] }, AGENT);
    await post(`/api/requests/${req.id}/quote`, { scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/requests/${req.id}/accept`, { evidence: 'phone' }, COORD);
    await post(`/api/requests/${req.id}/schedule`, { route: 'DIRECT', staffId: DOCTOR, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    const c = await post(`/api/requests/${req.id}/cancel`, { reason: 'Patient travelled', initiatedBy: 'PATIENT' }, COORD, '2026-11-12T07:00:00Z');
    expect(c.fee).toBe(35_000);
    await post(`/api/invoices/${c.invoiceId}/issue`, {}, FINANCE);
    await post(`/api/invoices/${c.invoiceId}/payments`, { method: 'LINK', amount: 35_000 }, FINANCE);
    const inv = await get(`/api/invoices/${c.invoiceId}`, FINANCE);
    expect(inv.status).toBe('PAID');
    expect(inv.lines[0].tax_category).toBe('S'); // fees are standard-rated by default
  });
});

describe('cycle 6 · monthly patient billed mid-treatment on demand: nothing billed twice', () => {
  it('interim invoices + the monthly run cover every shift and rental day exactly once', async () => {
    const req = await post('/api/requests', { channel: 'CALL_CENTER', patient: patient('9800000006'), items: [{ serviceCode: 'NRS-HOUR' }] }, AGENT, '2026-11-01T06:00:00Z');
    await post(`/api/requests/${req.id}/quote`, {}, COORD, '2026-11-01T06:10:00Z');
    await post(`/api/requests/${req.id}/accept`, { evidence: 'phone' }, COORD, '2026-11-01T06:20:00Z');
    const v = await post(`/api/requests/${req.id}/schedule`, { route: 'ASSESSMENT', staffId: DOCTOR, scheduledAt: '2026-11-01T08:00:00Z' }, COORD, '2026-11-01T06:30:00Z');
    await post(`/api/visits/${v.visitId}/dispatch`, {}, DOCTOR, '2026-11-01T07:30:00Z');
    await post(`/api/visits/${v.visitId}/check-in`, { ...HOME, consent: CONSENT }, DOCTOR, '2026-11-01T08:00:00Z');
    const ep = await post('/api/episodes', { requestId: req.id, diagnosis: 'Long-term care', suitable: true, billingCycle: 'WEEKLY' }, DOCTOR, '2026-11-01T08:30:00Z');
    // Finance switches this patient to monthly billing.
    expect((await ok(call('put', `/api/episodes/${ep.id}/billing-cycle`, { cycle: 'MONTHLY' }, FINANCE))).billingCycle).toBe('MONTHLY');
    await post(`/api/episodes/${ep.id}/care-plan`, { shiftHours: 8, hoursPerDay: 8, durationDays: 20 }, DOCTOR, '2026-11-01T09:00:00Z');
    const bed = await post(`/api/episodes/${ep.id}/orders`, { serviceCode: 'DEV-BED' }, DOCTOR, '2026-11-02T06:00:00Z');
    await post(`/api/orders/${bed.id}/result`, { report: 'Bed installed' }, DRIVER, '2026-11-02T08:00:00Z');
    const roster = await post(`/api/episodes/${ep.id}/roster`, { start: '2026-11-02T07:00:00Z', nurseIds: [RANA] }, COORD, '2026-11-01T10:00:00Z');
    const ids = roster.ids as number[];
    for (let i = 0; i < ids.length; i++) {
      const day = new Date(Date.UTC(2026, 10, 2 + i, 7)).toISOString();
      const end = new Date(Date.UTC(2026, 10, 2 + i, 15)).toISOString();
      await post(`/api/shifts/${ids[i]}/check-in`, HOME, RANA, day);
      await post(`/api/shifts/${ids[i]}/check-out`, { handover: 'Stable, routine care' }, RANA, end);
    }

    // Mid-month invoices on demand (the owner allows it by default).
    const a = await post(`/api/episodes/${ep.id}/interim-invoice`, { upTo: '2026-11-10' }, FINANCE);
    const b = await post(`/api/episodes/${ep.id}/interim-invoice`, { upTo: '2026-11-17' }, FINANCE);
    expect((await call('post', `/api/episodes/${ep.id}/interim-invoice`, { upTo: '2026-11-15' }, FINANCE)).status).toBe(409); // already billed past that
    // The automatic monthly run on 1 December picks up the rest.
    const run = await post('/api/billing/run', { asOf: '2026-12-01T06:00:00Z' }, FINANCE);
    const all = [a.invoiceId, b.invoiceId, ...run.created];
    const lines = (await Promise.all(all.map((id) => get(`/api/invoices/${id}`, FINANCE)))).flatMap((x: any) => x.lines);
    const shiftIds = lines.filter((l: any) => l.source_type === 'SHIFT').map((l: any) => l.source_id).sort((x: number, y: number) => x - y);
    expect(shiftIds).toEqual([...ids].sort((x, y) => x - y)); // every shift once
    const rentalDays = lines.filter((l: any) => l.source_type === 'RENTAL').reduce((s: number, l: any) => s + l.qty, 0);
    expect(rentalDays).toBe(29); // 2 Nov 08:00 → 1 Dec: 29 started days, billed across three invoices without overlap

    // A voided interim invoice puts its items back for the next invoice.
    await post(`/api/invoices/${b.invoiceId}/void`, { reason: 'Wrong period agreed with family' }, FINANCE);
    expect(db.get(`SELECT COUNT(*) AS n FROM shifts WHERE episode_id = ? AND invoice_id IS NULL AND status = 'COMPLETED'`, ep.id)!.n).toBeGreaterThan(0);

    // The owner can switch interim invoices off.
    await ok(call('put', '/api/settings', { interimInvoicing: false }, ADMIN));
    expect((await call('post', `/api/episodes/${ep.id}/interim-invoice`, {}, FINANCE)).status).toBe(403);
  });
});
