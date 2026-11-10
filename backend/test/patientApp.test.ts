import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';

const COORD = 3, LAB = 8;
let app: ReturnType<typeof createApp>;
let db: Db;

beforeEach(() => {
  db = new Db(':memory:');
  seed(db);
  app = createApp(db);
});

async function signIn(nationalId = '9990001112', phone = '0791234567', fullName = 'Rami Odeh') {
  const otp = await request(app).post('/api/patient-auth/request-otp').send({ nationalId, phone, fullName });
  expect(otp.body.sent).toBe(true);
  const v = await request(app).post('/api/patient-auth/verify').send({ nationalId, code: otp.body.devCode });
  expect(v.status).toBe(200);
  return v.body.token as string;
}

describe('patient app', () => {
  it('rejects requests without a session and staff routes without staff', async () => {
    expect((await request(app).get('/api/me')).status).toBe(401);
    expect((await request(app).post('/api/requests').send({})).status).toBe(401);
  });

  it('asks new patients for their name, refuses a phone that does not match the file', async () => {
    const r = await request(app).post('/api/patient-auth/request-otp').send({ nationalId: '9990001112', phone: '0791234567' });
    expect(r.body).toEqual({ needsName: true });
    await signIn();
    const wrong = await request(app).post('/api/patient-auth/request-otp').send({ nationalId: '9990001112', phone: '0780000000' });
    expect(wrong.status).toBe(400);
  });

  it('locks the code after repeated wrong attempts', async () => {
    await request(app).post('/api/patient-auth/request-otp').send({ nationalId: '9990001112', phone: '0791234567', fullName: 'Rami' });
    for (let i = 0; i < 5; i++) await request(app).post('/api/patient-auth/verify').send({ nationalId: '9990001112', code: '000000' });
    expect((await request(app).post('/api/patient-auth/verify').send({ nationalId: '9990001112', code: '000000' })).status).toBe(429);
  });

  it('books, completes the profile, accepts the quote and sees the visit code', async () => {
    const token = await signIn();
    const auth = { authorization: `Bearer ${token}` };

    const created = await request(app).post('/api/me/requests').set(auth).send({ items: [{ serviceCode: 'LAB-CBC', qty: 1 }], preferredAt: '2026-11-12T09:00:00Z' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('PENDING_INFO');

    await request(app).post('/api/me/profile').set(auth).send({ dob: '1985-02-02', gender: 'M', address: 'Irbid, University St', lat: 32.55, lng: 35.85, emergencyContact: 'Wife 0790000001' });
    let mine = (await request(app).get('/api/me/requests').set(auth)).body;
    expect(mine[0].status).toBe('UNDER_REVIEW');

    await request(app).post(`/api/requests/${created.body.id}/quote`).set('x-staff-id', String(COORD)).send({ scheduledAt: '2026-11-12T09:00:00Z' });
    mine = (await request(app).get('/api/me/requests').set(auth)).body;
    expect(mine[0].quote.patientTotal).toBe(8_000);

    expect((await request(app).post(`/api/me/requests/${created.body.id}/accept`).set(auth)).body.status).toBe('ACCEPTED');
    await request(app).post(`/api/requests/${created.body.id}/schedule`).set('x-staff-id', String(COORD)).send({ route: 'DIRECT', staffId: LAB, scheduledAt: '2026-11-12T09:00:00Z' });
    mine = (await request(app).get('/api/me/requests').set(auth)).body;
    expect(mine[0].visit.staff_name).toMatch(/Yousef/);
    expect(mine[0].visit.otp).toMatch(/^\d{4}$/);
  });

  it('cannot see or act on another patient\'s request', async () => {
    const a = await signIn('9990001112', '0791234567', 'Ali');
    const b = await signIn('9990003334', '0797654321', 'Bana');
    const r = await request(app).post('/api/me/requests').set({ authorization: `Bearer ${a}` }).send({ items: [{ serviceCode: 'LAB-CBC' }] });
    expect((await request(app).post(`/api/me/requests/${r.body.id}/cancel`).set({ authorization: `Bearer ${b}` }).send({ reason: 'not mine' })).status).toBe(404);
    expect((await request(app).get('/api/me/requests').set({ authorization: `Bearer ${b}` })).body).toEqual([]);
  });
});
