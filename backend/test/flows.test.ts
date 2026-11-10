// End-to-end walks through the BPMN: outpatient path and home-care path.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';

// Seeded staff ids
const AGENT = 2, COORD = 3, DOCTOR = 4, RANA = 5, HADI = 6, MAYA = 7, LAB = 8, DRIVER = 10, FINANCE = 11, SUPERVISOR = 12;
const HOME = { lat: 31.9539, lng: 35.9106 };

const patient = {
  nationalId: '9851234567', fullName: 'Ahmad Saleh', dob: '1948-03-02', gender: 'M' as const, phone: '0790000000',
  address: 'Amman, Khalda, Bldg 12', ...HOME, zoneId: 1, emergencyContact: 'Son 0791111111',
};

let app: ReturnType<typeof createApp>;
let db: Db;
const as = (staffId: number | null, at?: string) => {
  const h: Record<string, string> = {};
  if (staffId) h['x-staff-id'] = String(staffId);
  if (at) h['x-now'] = at;
  return h;
};
const post = (url: string, body: object, staffId: number | null, at?: string) => request(app).post(url).set(as(staffId, at)).send(body);

beforeEach(() => {
  db = new Db(':memory:');
  seed(db);
  app = createApp(db);
});

describe('intake', () => {
  it('parks incomplete requests in PENDING_INFO and resumes after the call', async () => {
    const res = await post('/api/requests', { channel: 'APP', patient: { nationalId: '9000000001', fullName: 'Mona' }, items: [{ serviceCode: 'LAB-CBC' }] }, null);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PENDING_INFO');
    expect(res.body.missing).toContain('gps location');

    const fix = await post(`/api/requests/${res.body.id}/complete-info`, { dob: '1990-01-01', gender: 'F', phone: '079', address: 'Zarqa', lat: 32, lng: 36, emergencyContact: 'x' }, AGENT);
    expect(fix.body).toEqual({ status: 'UNDER_REVIEW', missing: [] });
  });

  it('reuses the patient file by national ID', async () => {
    await post('/api/requests', { channel: 'APP', patient, items: [{ serviceCode: 'LAB-CBC' }] }, null);
    await post('/api/requests', { channel: 'CALL_CENTER', patient: { nationalId: patient.nationalId, fullName: patient.fullName }, items: [{ serviceCode: 'DOC-VISIT' }] }, AGENT);
    expect(db.get('SELECT COUNT(*) AS n FROM patients')!.n).toBe(1);
  });

  it('requires a supervisor for discounts above 10%', async () => {
    const { body } = await post('/api/requests', { channel: 'APP', patient, items: [{ serviceCode: 'LAB-CBC' }] }, null);
    expect((await post(`/api/requests/${body.id}/quote`, { discountPct: 20 }, COORD)).status).toBe(403);
    expect((await post(`/api/requests/${body.id}/quote`, { discountPct: 20, approvedBy: SUPERVISOR }, COORD)).status).toBe(200);
  });
});

describe('outpatient path (lab at home)', () => {
  it('runs request → quote → schedule → dispatch → check-in → result + payment', async () => {
    const created = await post('/api/requests', { channel: 'CALL_CENTER', patient, items: [{ serviceCode: 'LAB-CBC' }, { serviceCode: 'LAB-HBA1C' }] }, AGENT);
    expect(created.body.status).toBe('UNDER_REVIEW');
    const id = created.body.id;

    const quote = await post(`/api/requests/${id}/quote`, { scheduledAt: '2026-11-11T08:00:00Z' }, COORD);
    expect(quote.body.total).toBe(20_000);

    expect((await post(`/api/requests/${id}/accept`, {}, null)).body.status).toBe('ACCEPTED');

    // Coordinator cannot send a driver to take blood.
    expect((await post(`/api/requests/${id}/schedule`, { route: 'DIRECT', staffId: DRIVER, scheduledAt: '2026-11-11T08:00:00Z' }, COORD)).status).toBe(409);
    const sched = await post(`/api/requests/${id}/schedule`, { route: 'DIRECT', staffId: LAB, scheduledAt: '2026-11-11T08:00:00Z' }, COORD);
    expect(sched.body.kind).toBe('LAB');
    const visitId = sched.body.visitId;

    expect((await post(`/api/visits/${visitId}/dispatch`, {}, LAB)).body.status).toBe('DISPATCHED');
    const far = await post(`/api/visits/${visitId}/check-in`, { lat: 32.05, lng: 35.9 }, LAB);
    expect(far.status).toBe(400);
    expect((await post(`/api/visits/${visitId}/check-in`, { lat: HOME.lat + 0.0005, lng: HOME.lng }, LAB)).body.method).toBe('GPS');

    const done = await post(`/api/visits/${visitId}/complete`, { result: { report: 'CBC normal; HbA1c 6.1%' }, payment: { method: 'CASH', amount: 20_000 } }, LAB);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('COMPLETED');

    const file = await request(app).get(`/api/patients/${created.body.patient_id}`);
    expect(file.body.results).toHaveLength(2);
    expect(file.body.invoices[0].status).toBe('PAID');
  });

  it('charges a no-show fee and allows rescheduling', async () => {
    const { body } = await post('/api/requests', { channel: 'APP', patient, items: [{ serviceCode: 'DOC-VISIT' }] }, null);
    await post(`/api/requests/${body.id}/quote`, {}, COORD);
    await post(`/api/requests/${body.id}/accept`, {}, null);
    const { body: s } = await post(`/api/requests/${body.id}/schedule`, { route: 'DIRECT', staffId: DOCTOR, scheduledAt: '2026-11-11T10:00:00Z' }, COORD);
    await post(`/api/visits/${s.visitId}/dispatch`, {}, DOCTOR);
    const ns = await post(`/api/visits/${s.visitId}/no-show`, {}, DOCTOR);
    expect(ns.body.fee).toBe(17_500);
    const again = await post(`/api/requests/${body.id}/schedule`, { route: 'DIRECT', staffId: DOCTOR, scheduledAt: '2026-11-12T10:00:00Z' }, COORD);
    expect(again.status).toBe(200);
  });

  it('waits for insurer pre-approval before quoting covered services', async () => {
    db.run(`UPDATE insurance_policies SET covered_codes = '["IMG-XRAY"]'`);
    const { body } = await post('/api/requests', {
      channel: 'CALL_CENTER', patient, items: [{ serviceCode: 'IMG-XRAY' }], prescriptionRef: 'RX-1', insurance: { payerId: 2, memberNo: 'M-1' },
    }, AGENT);
    db.run(`UPDATE insurance_policies SET covered_codes = '["IMG-XRAY"]', copay_pct = 20`);
    const first = await post(`/api/requests/${body.id}/quote`, {}, COORD);
    expect(first.body.status).toBe('PENDING_PREAPPROVAL');
    const q = await post(`/api/requests/${body.id}/quote`, { preApprovalNo: 'PA-778', scheduledAt: '2026-11-11T09:00:00Z' }, COORD);
    expect(q.body.total).toBe(55_000); // insurer price list
    expect(q.body.patientTotal).toBe(11_000);
  });
});

describe('home care path', () => {
  async function admit() {
    const { body: r } = await post('/api/requests', { channel: 'APP', patient, items: [{ serviceCode: 'NRS-HOUR', qty: 1 }] }, null);
    await post(`/api/requests/${r.id}/quote`, {}, COORD);
    await post(`/api/requests/${r.id}/accept`, {}, null);
    const { body: s } = await post(`/api/requests/${r.id}/schedule`, { route: 'ASSESSMENT', staffId: DOCTOR, scheduledAt: '2026-11-01T09:00:00Z' }, COORD);
    await post(`/api/visits/${s.visitId}/dispatch`, {}, DOCTOR);
    const otp = db.get('SELECT otp FROM visits WHERE id = ?', s.visitId)!.otp;
    await post(`/api/visits/${s.visitId}/check-in`, { otp }, DOCTOR);
    const ep = await post('/api/episodes', { requestId: r.id, diagnosis: 'Post-stroke care', suitable: true, bradenScore: 14, fallRiskScore: 55, allergies: ['Penicillin'] }, DOCTOR);
    expect(ep.status).toBe(201);
    return { requestId: r.id, episodeId: ep.body.id as number, patientId: r.patient_id as number };
  }

  it('refers out when home care is not suitable', async () => {
    const { body: r } = await post('/api/requests', { channel: 'APP', patient, items: [{ serviceCode: 'DOC-VISIT' }] }, null);
    await post(`/api/requests/${r.id}/quote`, {}, COORD);
    await post(`/api/requests/${r.id}/accept`, {}, null);
    const { body: s } = await post(`/api/requests/${r.id}/schedule`, { route: 'ASSESSMENT', staffId: RANA, scheduledAt: '2026-11-01T09:00:00Z' }, COORD);
    await post(`/api/visits/${s.visitId}/dispatch`, {}, RANA);
    await post(`/api/visits/${s.visitId}/check-in`, HOME, RANA);
    const ep = await post('/api/episodes', { requestId: r.id, diagnosis: 'Unstable angina', suitable: false, referReason: 'Needs cardiac monitoring' }, RANA);
    expect(ep.body.status).toBe('REFERRED_OUT');
    expect(db.get('SELECT status FROM service_requests WHERE id = ?', r.id)!.status).toBe('REFERRED_OUT');
  });

  it('orders go to departments, critical results escalate until the doctor acknowledges', async () => {
    const { episodeId } = await admit();
    const order = await post(`/api/episodes/${episodeId}/orders`, { serviceCode: 'LAB-PANEL', priority: 'URGENT' }, DOCTOR);
    expect(order.body.department).toBe('LAB');
    const worklist = await request(app).get('/api/orders?department=LAB');
    expect(worklist.body).toHaveLength(1);
    const res = await post(`/api/orders/${order.body.id}/result`, { report: 'K+ 6.8 mmol/L', critical: true }, LAB);
    expect(db.get(`SELECT status FROM escalations WHERE trigger = 'CRITICAL_RESULT'`)!.status).toBe('OPEN');
    await post(`/api/results/${res.body.id}/acknowledge`, {}, DOCTOR);
    expect(db.get(`SELECT status FROM escalations WHERE trigger = 'CRITICAL_RESULT'`)!.status).toBe('RESOLVED');
  });

  it('roster → late alert → backup nurse → vitals escalation → check-out → weekly invoice → discharge', async () => {
    const { episodeId, patientId } = await admit();
    // Roster without a care plan is refused.
    expect((await post(`/api/episodes/${episodeId}/roster`, { start: '2026-11-02T07:00:00Z', nurseIds: [RANA] }, COORD)).status).toBe(409);
    await post(`/api/episodes/${episodeId}/care-plan`, { shiftHours: 12, hoursPerDay: 24, durationDays: 3 }, DOCTOR);
    const roster = await post(`/api/episodes/${episodeId}/roster`, { start: '2026-11-02T07:00:00Z', nurseIds: [RANA, HADI] }, COORD);
    expect(roster.body.shifts).toBe(6);
    const [first, second] = roster.body.ids as number[];

    // Rana does not show up: flagged after the 15-minute grace, Maya covers.
    const late = await post('/api/shifts/check-late', {}, null, '2026-11-02T07:20:00Z');
    expect(late.body.late).toEqual([first]);
    const { body: cover } = await post(`/api/shifts/${first}/reassign`, { nurseId: MAYA }, COORD, '2026-11-02T07:22:00Z');
    expect((await post(`/api/shifts/${cover.newShiftId}/check-in`, HOME, RANA)).status).toBe(403);
    expect((await post(`/api/shifts/${cover.newShiftId}/check-in`, HOME, MAYA, '2026-11-02T07:50:00Z')).status).toBe(200);

    const ok = await post(`/api/shifts/${cover.newShiftId}/vitals`, { respRate: 16, spo2: 97, onOxygen: false, systolicBp: 125, heartRate: 75, consciousness: 'A', temperature: 37 }, MAYA);
    expect(ok.body.news2.band).toBe('LOW');
    expect(ok.body.escalationId).toBeUndefined();
    const bad = await post(`/api/shifts/${cover.newShiftId}/vitals`, { respRate: 22, spo2: 97, onOxygen: false, systolicBp: 125, heartRate: 115, consciousness: 'A', temperature: 38.5 }, MAYA);
    expect(bad.body.news2.band).toBe('MEDIUM');
    expect(bad.body.escalationId).toBeTypeOf('number');
    await post(`/api/escalations/${bad.body.escalationId}/ack`, { decision: 'Paracetamol, recheck in 1h', resolve: true }, DOCTOR);

    expect((await post(`/api/shifts/${cover.newShiftId}/check-out`, { handover: 'Stable after antipyretic, BP 125/80' }, MAYA, '2026-11-02T19:00:00Z')).body.billableMinutes).toBe((11 * 60) + 15);
    await post(`/api/shifts/${second}/check-in`, HOME, HADI, '2026-11-02T19:05:00Z');
    expect((await post(`/api/shifts/${second}/check-out`, { handover: 'Slept well, no events' }, HADI, '2026-11-03T07:00:00Z')).body.billableMinutes).toBe(720);

    // Weekly billing for the week that contains these shifts.
    const run = await post('/api/billing/run', { asOf: '2026-11-10T06:00:00Z' }, FINANCE);
    expect(run.body.created).toHaveLength(1);
    const again = await post('/api/billing/run', { asOf: '2026-11-10T06:00:00Z' }, FINANCE);
    expect(again.body.created).toHaveLength(0);
    const inv = (await request(app).get(`/api/invoices/${run.body.created[0]}`)).body;
    expect(inv.lines).toHaveLength(2);
    expect(inv.total).toBe(Math.round(11.25 * 6_000) + 12 * 6_000);
    expect((await post(`/api/invoices/${inv.id}/issue`, {}, FINANCE)).body.status).toBe('ISSUED');
    expect((await post(`/api/invoices/${inv.id}/payments`, { method: 'CLIQ', amount: inv.patient_total }, FINANCE)).body.status).toBe('PAID');

    const dis = await post(`/api/episodes/${episodeId}/discharge`, { summary: 'Recovered mobility, family trained on transfers' }, DOCTOR, '2026-11-04T12:00:00Z');
    expect(dis.body.status).toBe('DISCHARGED');
    const file = (await request(app).get(`/api/patients/${patientId}`)).body;
    expect(file.allergies).toEqual(['Penicillin']);
    expect(file.episodes[0].status).toBe('DISCHARGED');
  });

  it('high NEWS2 puts the episode on hold', async () => {
    const { episodeId } = await admit();
    await post(`/api/episodes/${episodeId}/care-plan`, { shiftHours: 8, hoursPerDay: 8, durationDays: 1 }, DOCTOR);
    const { body } = await post(`/api/episodes/${episodeId}/roster`, { start: '2026-11-02T07:00:00Z', nurseIds: [RANA] }, COORD);
    await post(`/api/shifts/${body.ids[0]}/check-in`, HOME, RANA);
    const v = await post(`/api/shifts/${body.ids[0]}/vitals`, { respRate: 26, spo2: 90, onOxygen: true, systolicBp: 95, heartRate: 75, consciousness: 'A', temperature: 37 }, RANA);
    expect(v.body.news2.band).toBe('HIGH');
    expect(db.get('SELECT status FROM episodes WHERE id = ?', episodeId)!.status).toBe('ON_HOLD');
  });
});
