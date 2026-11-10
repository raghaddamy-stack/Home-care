// Product features: coordinator KPI/SLA dashboard and patient satisfaction ratings.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';
import { ammanDay, slaFor } from '../src/routes/dashboard.js';

const AGENT = 2, COORD = 3, LAB = 8, NURSE = 5, SUPERVISOR = 12;
const HOME = { lat: 31.9539, lng: 35.9106 };
const patient = {
  nationalId: '9851234567', fullName: 'Ahmad Saleh', dob: '1948-03-02', gender: 'M' as const, phone: '0790000000',
  address: 'Amman, Khalda', ...HOME, zoneId: 1, emergencyContact: 'Son 0791111111',
};

let app: ReturnType<typeof createApp>;
let db: Db;
const staff = (id: number, at?: string) => ({ 'x-staff-id': String(id), ...(at ? { 'x-now': at } : {}) });
const post = (url: string, body: object, id: number) => request(app).post(url).set(staff(id)).send(body);

beforeEach(() => {
  db = new Db(':memory:');
  seed(db);
  app = createApp(db);
});

async function signIn(nationalId = patient.nationalId, phone = patient.phone) {
  const otp = await request(app).post('/api/patient-auth/request-otp').send({ nationalId, phone, fullName: 'Ahmad' });
  const v = await request(app).post('/api/patient-auth/verify').send({ nationalId, code: otp.body.devCode });
  return { authorization: `Bearer ${v.body.token}` };
}

/** Call-center request driven all the way to a completed lab visit. */
async function completedLabVisit() {
  const { body } = await post('/api/requests', { channel: 'CALL_CENTER', patient, items: [{ serviceCode: 'LAB-CBC' }] }, AGENT);
  await post(`/api/requests/${body.id}/quote`, {}, COORD);
  await post(`/api/requests/${body.id}/accept`, {}, COORD);
  const s = await post(`/api/requests/${body.id}/schedule`, { route: 'DIRECT', staffId: LAB, scheduledAt: new Date().toISOString() }, COORD);
  const otp = db.get('SELECT otp FROM visits WHERE id = ?', s.body.visitId)!.otp;
  await post(`/api/visits/${s.body.visitId}/dispatch`, {}, LAB);
  await post(`/api/visits/${s.body.visitId}/check-in`, { otp, consent: { signedBy: 'Patient', relation: 'SELF', method: 'ESIGN' } }, LAB);
  const done = await post(`/api/visits/${s.body.visitId}/complete`, { result: { report: 'normal' } }, LAB);
  expect(done.body.status).toBe('COMPLETED');
  return body.id as number;
}

describe('SLA rules', () => {
  it('picks the SLA by status and urgency', () => {
    expect(slaFor('UNDER_REVIEW', 'ROUTINE')).toEqual({ kind: 'review', minutes: 30 });
    expect(slaFor('ACCEPTED', 'SAME_DAY')).toEqual({ kind: 'schedule', minutes: 180 });
    expect(slaFor('ACCEPTED', 'ROUTINE')!.minutes).toBe(1440);
    expect(slaFor('PENDING_INFO', 'ROUTINE')).toBeNull();
    expect(slaFor('COMPLETED', 'URGENT')).toBeNull();
  });

  it('cuts the day at Amman midnight (UTC+3)', () => {
    expect(ammanDay(new Date('2026-11-10T22:30:00Z'))).toEqual(['2026-11-10T21:00:00.000Z', '2026-11-11T21:00:00.000Z']);
    expect(ammanDay(new Date('2026-11-10T20:59:00Z'))[0]).toBe('2026-11-09T21:00:00.000Z');
  });
});

describe('coordinator dashboard', () => {
  it('is for desk staff only', async () => {
    expect((await request(app).get('/api/dashboard/coordinator')).status).toBe(401);
    expect((await request(app).get('/api/dashboard/coordinator').set(staff(NURSE))).status).toBe(403);
  });

  it('counts queues and flags requests waiting past the review SLA', async () => {
    const a = await post('/api/requests', { channel: 'APP', patient, items: [{ serviceCode: 'LAB-CBC' }] }, AGENT);
    await post('/api/requests', { channel: 'APP', patient: { nationalId: '9000000001', fullName: 'Mona' }, items: [{ serviceCode: 'LAB-CBC' }] }, AGENT);
    const b = await post('/api/requests', { channel: 'APP', patient, urgency: 'SAME_DAY', items: [{ serviceCode: 'DOC-VISIT' }] }, AGENT);
    await post(`/api/requests/${b.body.id}/quote`, {}, COORD);
    await post(`/api/requests/${b.body.id}/accept`, {}, COORD);

    const fresh = (await request(app).get('/api/dashboard/coordinator').set(staff(COORD))).body;
    expect(fresh.queues).toMatchObject({ toReview: 1, pendingInfo: 1, toSchedule: 1, urgentOpen: 1 });
    expect(fresh.today.newRequests).toBe(3);
    expect(fresh.sla.overdueCount).toBe(0);

    // 45 minutes later the review is late; the same-day schedule (3 h) is not yet.
    const later = new Date(Date.now() + 45 * 60_000).toISOString();
    const late = (await request(app).get('/api/dashboard/coordinator').set(staff(COORD, later))).body;
    expect(late.sla.overdue).toEqual([expect.objectContaining({ id: a.body.id, kind: 'review', slaMinutes: 30 })]);

    // 4 hours later the same-day request is late too.
    const muchLater = new Date(Date.now() + 4 * 3600_000).toISOString();
    const both = (await request(app).get('/api/dashboard/coordinator').set(staff(COORD, muchLater))).body;
    expect(both.sla.overdue.map((x: any) => x.kind).sort()).toEqual(['review', 'schedule']);
  });
});

describe('patient ratings', () => {
  it('asks for a rating after the visit, takes it once, and opens a follow-up on a low score', async () => {
    const id = await completedLabVisit();
    const auth = await signIn();

    const pending = (await request(app).get('/api/me/feedback/pending').set(auth)).body;
    expect(pending).toEqual([expect.objectContaining({ requestId: id, staffName: expect.stringMatching(/Yousef/) })]);

    expect((await request(app).post(`/api/me/requests/${id}/rating`).set(auth).send({ score: 6 })).status).toBe(400);
    const r = await request(app).post(`/api/me/requests/${id}/rating`).set(auth).send({ score: 2, tags: ['LATE'], comment: 'تأخروا ساعة' });
    expect(r.status).toBe(201);
    expect(r.body.followUp).toBe(true);
    expect((await request(app).post(`/api/me/requests/${id}/rating`).set(auth).send({ score: 5 })).status).toBe(409);
    expect((await request(app).get('/api/me/feedback/pending').set(auth)).body).toEqual([]);
    expect(db.get(`SELECT 1 FROM notifications WHERE recipient = 'role:SUPERVISOR' AND message LIKE 'Low rating%'`)).toBeTruthy();

    const dash = (await request(app).get('/api/dashboard/coordinator').set(staff(COORD))).body;
    expect(dash.csat).toEqual({ avg: 2, responses: 1, openFollowUps: 1 });

    const open = (await request(app).get('/api/feedback?followUp=OPEN').set(staff(SUPERVISOR))).body;
    expect(open[0]).toMatchObject({ request_no: expect.any(String), score: 2, tags: ['LATE'], staff_name: expect.stringMatching(/Yousef/) });
    expect((await post(`/api/feedback/${open[0].id}/close`, { note: 'اتصلنا واعتذرنا' }, NURSE)).status).toBe(403);
    expect((await post(`/api/feedback/${open[0].id}/close`, { note: 'اتصلنا واعتذرنا' }, SUPERVISOR)).status).toBe(200);
    expect((await post(`/api/feedback/${open[0].id}/close`, { note: 'again' }, SUPERVISOR)).status).toBe(409);
    expect((await request(app).get('/api/feedback?followUp=OPEN').set(staff(COORD))).body).toEqual([]);
  });

  it('refuses ratings before the visit is done and on other patients\' requests', async () => {
    const auth = await signIn();
    const mine = await request(app).post('/api/me/requests').set(auth).send({ items: [{ serviceCode: 'LAB-CBC' }] });
    expect((await request(app).post(`/api/me/requests/${mine.body.id}/rating`).set(auth).send({ score: 5 })).status).toBe(409);

    const id = await completedLabVisit();
    const other = await signIn('9990003334', '0797654321');
    expect((await request(app).post(`/api/me/requests/${id}/rating`).set(other).send({ score: 5 })).status).toBe(404);
  });

  it('stops asking after the rating window', async () => {
    await completedLabVisit();
    const auth = await signIn();
    const in20Days = new Date(Date.now() + 20 * 86_400_000).toISOString();
    expect((await request(app).get('/api/me/feedback/pending').set({ ...auth, 'x-now': in20Days })).body).toEqual([]);
  });
});
