// End-to-end tests for the rules added in the BA gap-analysis round (docs/ba-gap-analysis.md).
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';

const AGENT = 2, COORD = 3, DOCTOR = 4, RANA = 5, HADI = 6, LAB = 8, SUPERVISOR = 12;
const HOME = { lat: 31.9539, lng: 35.9106 };
const CONSENT = { signedBy: 'Ahmad Saleh', relation: 'SELF', method: 'ESIGN' };
const patient = {
  nationalId: '9851234567', fullName: 'Ahmad Saleh', dob: '1948-03-02', gender: 'M' as const, phone: '0790000000',
  address: 'Amman, Khalda, Bldg 12', ...HOME, zoneId: 1, emergencyContact: 'Son 0791111111',
};

let app: ReturnType<typeof createApp>;
let db: Db;
const post = (url: string, body: object, staffId: number | null, at?: string) => {
  const h: Record<string, string> = {};
  if (staffId) h['x-staff-id'] = String(staffId);
  if (at) h['x-now'] = at;
  return request(app).post(url).set(h).send(body);
};
const at = (iso: string, plusH: number) => new Date(new Date(iso).getTime() + plusH * 3600_000).toISOString();

beforeEach(() => {
  db = new Db(':memory:');
  seed(db);
  app = createApp(db);
});

const T0 = '2026-11-10T08:00:00Z';

/** Request → quote (at T0) → accepted. Returns the request id. */
async function accepted(items = [{ serviceCode: 'DOC-VISIT' }], p: object = patient, urgency = 'ROUTINE') {
  const { body } = await post('/api/requests', { channel: 'CALL_CENTER', patient: p, items, urgency }, AGENT);
  await post(`/api/requests/${body.id}/quote`, {}, COORD, T0);
  expect((await post(`/api/requests/${body.id}/accept`, {}, COORD, T0)).status).toBe(200);
  return body.id as number;
}

async function schedule(id: number, when: string, staffId = DOCTOR, nowIso = T0) {
  return post(`/api/requests/${id}/schedule`, { route: 'DIRECT', staffId, scheduledAt: when }, COORD, nowIso);
}

describe('BR-12 quote validity', () => {
  it('refuses an expired quote, moves the request to EXPIRED, and a new version can be accepted', async () => {
    const { body } = await post('/api/requests', { channel: 'APP', patient, items: [{ serviceCode: 'DOC-VISIT' }] }, AGENT);
    const q = await post(`/api/requests/${body.id}/quote`, {}, COORD, T0);
    expect(q.body.validUntil).toBe(at(T0, 48));

    const late = await post(`/api/requests/${body.id}/accept`, { evidence: 'call 991' }, COORD, at(T0, 49));
    expect(late.status).toBe(409);
    expect(late.body.error).toMatch(/BR-12/);
    expect(db.get('SELECT status FROM service_requests WHERE id = ?', body.id)!.status).toBe('EXPIRED');

    const v2 = await post(`/api/requests/${body.id}/quote`, {}, COORD, at(T0, 50));
    expect(v2.body.version).toBe(2);
    expect((await post(`/api/requests/${body.id}/accept`, {}, COORD, at(T0, 51))).body.status).toBe('ACCEPTED');
  });

  it('same-day quotes last 4 h, and the sweep expires open quotes', async () => {
    const { body } = await post('/api/requests', { channel: 'APP', patient, items: [{ serviceCode: 'LAB-CBC' }], urgency: 'SAME_DAY' }, AGENT);
    await post(`/api/requests/${body.id}/quote`, {}, COORD, T0);
    expect((await post('/api/requests/expire-quotes', {}, null, at(T0, 3))).body.expired).toEqual([]);
    expect((await post('/api/requests/expire-quotes', {}, null, at(T0, 5))).body.expired).toEqual([body.id]);
    expect((await post(`/api/requests/${body.id}/accept`, {}, COORD, at(T0, 5))).status).toBe(409);
  });
});

describe('BR-23 cancellation fee by notice time', () => {
  it('free with more than 24 h notice', async () => {
    const id = await accepted();
    await schedule(id, at(T0, 72));
    const c = await post(`/api/requests/${id}/cancel`, { reason: 'Travelling' }, AGENT, at(T0, 40));
    expect(c.body).toMatchObject({ status: 'CANCELLED', fee: 0 });
    expect(db.get(`SELECT status FROM visits WHERE request_id = ?`, id)!.status).toBe('CANCELLED');
  });

  it('50% between 24 h and 2 h, on a draft invoice; the preview shows the same fee', async () => {
    const id = await accepted(); // DOC-VISIT 35 JOD cash
    await schedule(id, at(T0, 30));
    const preview = await request(app).get(`/api/requests/${id}`).set('x-now', at(T0, 20));
    expect(preview.body.cancellation).toMatchObject({ pct: 50, fee: 17_500 });
    const c = await post(`/api/requests/${id}/cancel`, { reason: 'Feeling better' }, AGENT, at(T0, 20));
    expect(c.body).toMatchObject({ fee: 17_500, feePct: 50 });
    const inv = db.get('SELECT * FROM invoices WHERE id = ?', c.body.invoiceId)!;
    expect(inv).toMatchObject({ status: 'DRAFT', patient_total: 17_500 });
  });

  it('100% once the team is on the way; none when the company cancels', async () => {
    const id = await accepted();
    const { body: s } = await schedule(id, at(T0, 30));
    await post(`/api/visits/${s.visitId}/dispatch`, {}, DOCTOR, at(T0, 29.5));
    const c = await post(`/api/requests/${id}/cancel`, { reason: 'Changed my mind' }, AGENT, at(T0, 29.6));
    expect(c.body).toMatchObject({ status: 'CANCELLED', fee: 35_000, feePct: 100 });

    const id2 = await accepted([{ serviceCode: 'LAB-CBC' }]);
    await schedule(id2, at(T0, 1), LAB);
    const c2 = await post(`/api/requests/${id2}/cancel`, { reason: 'No lab tech available', initiatedBy: 'COMPANY' }, COORD, at(T0, 0.5));
    expect(c2.body.fee).toBe(0);
  });

  it('rescheduling replaces the booked visit instead of keeping two open', async () => {
    const id = await accepted();
    await schedule(id, at(T0, 30));
    await schedule(id, at(T0, 54));
    const visits = db.all('SELECT status FROM visits WHERE request_id = ? ORDER BY id', id).map((v) => v.status);
    expect(visits).toEqual(['CANCELLED', 'SCHEDULED']);
  });
});

describe('BR-24 second no-show in 30 days needs prepayment', () => {
  it('blocks booking until the visit fee is prepaid, then applies the prepayment to the invoice', async () => {
    const id = await accepted([{ serviceCode: 'LAB-CBC' }]); // 8 JOD
    for (const day of [1, 3]) {
      const { body: s } = await schedule(id, at(T0, day * 24), LAB);
      await post(`/api/visits/${s.visitId}/dispatch`, {}, LAB);
      const ns = await post(`/api/visits/${s.visitId}/no-show`, {}, LAB, at(T0, day * 24 + 0.5));
      expect(ns.body.fee).toBe(10_000); // minimum fee
      expect(ns.body.prepaymentRequired).toBe(day === 3);
    }
    const blocked = await schedule(id, at(T0, 7 * 24), LAB, at(T0, 73));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/BR-24/);

    const pre = await post(`/api/requests/${id}/prepayments`, { method: 'CLIQ', amount: 8_000, reference: 'CLQ-1' }, AGENT, at(T0, 73));
    expect(pre.body).toMatchObject({ required: true, outstanding: 0 });
    const { body: s } = await schedule(id, at(T0, 7 * 24), LAB, at(T0, 73));
    await post(`/api/visits/${s.visitId}/dispatch`, {}, LAB);
    await post(`/api/visits/${s.visitId}/check-in`, { ...HOME, consent: CONSENT }, LAB, at(T0, 7 * 24));
    const done = await post(`/api/visits/${s.visitId}/complete`, { result: { report: 'CBC normal' } }, LAB, at(T0, 7 * 24 + 0.3));
    expect(db.get('SELECT status FROM invoices WHERE id = ?', done.body.invoiceId)!.status).toBe('PAID');
  });
});

describe('BR-80 consent before the first visit', () => {
  async function atTheDoor(p: object = patient, whenH = 2) {
    const id = await accepted([{ serviceCode: 'LAB-CBC' }], p);
    const { body: s } = await schedule(id, at(T0, whenH), LAB);
    await post(`/api/visits/${s.visitId}/dispatch`, {}, LAB);
    return { id, visitId: s.visitId as number };
  }

  it('refuses check-in without consent; staff can capture it at the door', async () => {
    const { visitId } = await atTheDoor();
    const no = await post(`/api/visits/${visitId}/check-in`, HOME, LAB, at(T0, 2));
    expect(no.status).toBe(409);
    expect(no.body.error).toMatch(/BR-80/);
    expect((await post(`/api/visits/${visitId}/check-in`, { ...HOME, consent: CONSENT }, LAB, at(T0, 2))).status).toBe(200);
  });

  it('a minor needs a guardian signature (BR-03)', async () => {
    const child = { ...patient, nationalId: '2015000001', fullName: 'Lana', dob: '2015-06-01' };
    const { visitId } = await atTheDoor(child);
    const self = await post(`/api/visits/${visitId}/check-in`, { ...HOME, consent: { signedBy: 'Lana', relation: 'SELF' } }, LAB, at(T0, 2));
    expect(self.status).toBe(409);
    expect(self.body.error).toMatch(/guardian/);
    const parent = await post(`/api/visits/${visitId}/check-in`, { ...HOME, consent: { signedBy: 'Mother', relation: 'PARENT' } }, LAB, at(T0, 2));
    expect(parent.status).toBe(200);
  });

  it('consent on file is reused; once revoked the next visit is blocked again', async () => {
    const pid = db.get('SELECT id FROM patients WHERE national_id = ?', patient.nationalId)?.id
      ?? (await post('/api/requests', { channel: 'APP', patient, items: [{ serviceCode: 'LAB-CBC' }] }, AGENT)).body.patient_id;
    const c = await post(`/api/patients/${pid}/consents`, { signedBy: 'Ahmad Saleh', method: 'PAPER' }, AGENT, T0);
    expect(c.status).toBe(201);
    const { visitId } = await atTheDoor();
    expect((await post(`/api/visits/${visitId}/check-in`, HOME, LAB, at(T0, 2))).status).toBe(200);

    await post(`/api/consents/${c.body.ids[0]}/revoke`, {}, AGENT, at(T0, 3));
    const { visitId: v2 } = await atTheDoor(patient, 4);
    expect((await post(`/api/visits/${v2}/check-in`, HOME, LAB, at(T0, 4))).status).toBe(409);
  });
});

describe('§5.5 escalation timers', () => {
  async function episode() {
    const id = await accepted([{ serviceCode: 'NRS-HOUR' }]);
    const { body: s } = await post(`/api/requests/${id}/schedule`, { route: 'ASSESSMENT', staffId: DOCTOR, scheduledAt: at(T0, 1) }, COORD, T0);
    await post(`/api/visits/${s.visitId}/dispatch`, {}, DOCTOR);
    await post(`/api/visits/${s.visitId}/check-in`, { ...HOME, consent: CONSENT }, DOCTOR, at(T0, 1));
    const ep = await post('/api/episodes', { requestId: id, diagnosis: 'CHF', suitable: true }, DOCTOR, at(T0, 1.5));
    return ep.body.id as number;
  }

  it('critical result not acknowledged in 30 min goes to the medical director', async () => {
    const ep = await episode();
    const order = await post(`/api/episodes/${ep}/orders`, { serviceCode: 'LAB-PANEL' }, DOCTOR);
    const res = await post(`/api/orders/${order.body.id}/result`, { report: 'K+ 6.9', critical: true }, LAB, at(T0, 3));
    expect((await post('/api/escalations/check-timers', {}, null, at(T0, 3.4))).body.escalated).toEqual([]);
    const sweep = await post('/api/escalations/check-timers', {}, null, at(T0, 3.6));
    expect(sweep.body.escalated).toHaveLength(1);
    expect(db.get(`SELECT * FROM notifications WHERE recipient = 'role:MEDICAL_DIRECTOR'`)).toBeTruthy();
    expect(db.get('SELECT escalated_at FROM results WHERE id = ?', res.body.id)!.escalated_at).toBeTruthy();
    // Swept once only.
    expect((await post('/api/escalations/check-timers', {}, null, at(T0, 4))).body.escalated).toEqual([]);
  });

  it('outpatient critical results are escalated too (they have no episode)', async () => {
    const id = await accepted([{ serviceCode: 'LAB-CBC' }]);
    const { body: s } = await schedule(id, at(T0, 2), LAB);
    await post(`/api/visits/${s.visitId}/dispatch`, {}, LAB);
    await post(`/api/visits/${s.visitId}/check-in`, { ...HOME, consent: CONSENT }, LAB, at(T0, 2));
    const done = await post(`/api/visits/${s.visitId}/complete`, { result: { report: 'Hb 5.9', critical: true } }, LAB, at(T0, 2.2));
    const sweep = await post('/api/escalations/check-timers', {}, null, at(T0, 2.8));
    expect(sweep.body.escalatedResults).toEqual([done.body.resultId]);
  });

  it('NEWS2 5–6: on-call has 15 min, the nurse is asked to recheck; NEWS2 ≥7 reaches the medical director at once', async () => {
    const ep = await episode();
    await post(`/api/episodes/${ep}/care-plan`, { shiftHours: 12, hoursPerDay: 12, durationDays: 1 }, DOCTOR);
    const { body } = await post(`/api/episodes/${ep}/roster`, { start: at(T0, 24), nurseIds: [RANA] }, COORD);
    await post(`/api/shifts/${body.ids[0]}/check-in`, HOME, RANA, at(T0, 24));
    const v = await post(`/api/shifts/${body.ids[0]}/vitals`, { respRate: 22, spo2: 97, onOxygen: false, systolicBp: 125, heartRate: 115, consciousness: 'A', temperature: 38.5 }, RANA, at(T0, 25));
    expect(v.body.news2.band).toBe('MEDIUM');
    const sweep = await post('/api/escalations/check-timers', {}, null, at(T0, 25.3));
    expect(sweep.body.escalated).toEqual([v.body.escalationId]);
    expect(sweep.body.recheck).toEqual([v.body.escalationId]);
    expect(db.get(`SELECT * FROM notifications WHERE recipient = 'staff:${RANA}' AND message LIKE 'Recheck vitals%'`)).toBeTruthy();

    const high = await post(`/api/shifts/${body.ids[0]}/vitals`, { respRate: 26, spo2: 90, onOxygen: true, systolicBp: 95, heartRate: 75, consciousness: 'A', temperature: 37 }, RANA, at(T0, 25.5));
    expect(db.get('SELECT escalated_to FROM escalations WHERE id = ?', high.body.escalationId)!.escalated_to).toBe('MEDICAL_DIRECTOR');
  });
});

describe('BR-33 nurse working-time limits', () => {
  async function episodeWithPlan(plan: object) {
    const id = await accepted([{ serviceCode: 'NRS-HOUR' }]);
    const { body: s } = await post(`/api/requests/${id}/schedule`, { route: 'ASSESSMENT', staffId: DOCTOR, scheduledAt: at(T0, 1) }, COORD, T0);
    await post(`/api/visits/${s.visitId}/dispatch`, {}, DOCTOR);
    await post(`/api/visits/${s.visitId}/check-in`, { ...HOME, consent: CONSENT }, DOCTOR, at(T0, 1));
    const ep = (await post('/api/episodes', { requestId: id, diagnosis: 'Palliative care', suitable: true }, DOCTOR)).body.id;
    await post(`/api/episodes/${ep}/care-plan`, plan, DOCTOR);
    return ep as number;
  }

  it('one nurse cannot cover 24 h with 8 h shifts; a supervisor may override with a reason', async () => {
    const ep = await episodeWithPlan({ shiftHours: 8, hoursPerDay: 24, durationDays: 2 });
    const r = await post(`/api/episodes/${ep}/roster`, { start: at(T0, 24), nurseIds: [RANA] }, COORD);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/BR-33/);
    expect((await post(`/api/episodes/${ep}/roster`, { start: at(T0, 24), nurseIds: [RANA], overrideReason: 'Family emergency cover' }, COORD)).status).toBe(409);
    expect((await post(`/api/episodes/${ep}/roster`, { start: at(T0, 24), nurseIds: [RANA], overrideReason: 'Family emergency cover' }, SUPERVISOR)).status).toBe(201);
  });

  it('12 h on / 12 h off with two nurses is fine; more than 60 h a week is not', async () => {
    const ok = await episodeWithPlan({ shiftHours: 12, hoursPerDay: 24, durationDays: 3 });
    expect((await post(`/api/episodes/${ok}/roster`, { start: at(T0, 24), nurseIds: [RANA, HADI] }, COORD)).status).toBe(201);
    const week = await episodeWithPlan({ shiftHours: 12, hoursPerDay: 12, durationDays: 6 });
    const r = await post(`/api/episodes/${week}/roster`, { start: at(T0, 24 * 10), nurseIds: [HADI] }, COORD);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/72 h in the 7 days/);
  });
});
