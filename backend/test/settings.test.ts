// Owner settings: storage, validation, and each policy actually following the configured value.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';
import { noShowFee } from '../src/domain/patientPolicy.js';
import { isAfterHours } from '../src/domain/pricing.js';

const ADMIN = 1, AGENT = 2, COORD = 3, DOCTOR = 4, RANA = 5, HADI = 6, LAB = 8, FINANCE = 11;
const HOME = { lat: 31.9539, lng: 35.9106 };
const CONSENT = { signedBy: 'Patient', relation: 'SELF', method: 'ESIGN' };
const patient = {
  nationalId: '9851230000', fullName: 'Huda Nasser', dob: '1950-03-02', gender: 'F' as const, phone: '0790000009',
  address: 'Amman', ...HOME, zoneId: 1, emergencyContact: 'Son 0791111111',
};

let app: ReturnType<typeof createApp>;
let db: Db;
const post = (url: string, body: object, staffId?: number, at?: string) => {
  const r = request(app).post(url);
  if (staffId) r.set('x-staff-id', String(staffId));
  if (at) r.set('x-now', at);
  return r.send(body);
};
const setSettings = (patch: object) => request(app).put('/api/settings').set('x-staff-id', String(ADMIN)).send(patch);

beforeEach(() => {
  db = new Db(':memory:');
  seed(db);
  app = createApp(db); // also reloads settings from this (empty) database → defaults
});

async function acceptedRequest(code = 'LAB-CBC', extra: object = {}) {
  const { body } = await post('/api/requests', { channel: 'CALL_CENTER', patient: { ...patient, ...extra }, items: [{ serviceCode: code }] }, AGENT);
  await post(`/api/requests/${body.id}/quote`, { scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
  await post(`/api/requests/${body.id}/accept`, {}, COORD);
  return body.id as number;
}

describe('settings store', () => {
  it('only the owner (ADMIN) reads and changes settings; values are validated and audited', async () => {
    expect((await request(app).get('/api/settings').set('x-staff-id', String(COORD))).status).toBe(403);
    const got = await request(app).get('/api/settings').set('x-staff-id', String(ADMIN));
    expect(got.body.values.noShowFeePct).toBe(50);
    expect(got.body.meta.length).toBeGreaterThan(40);

    expect((await setSettings({ noShowFeePct: 150 })).status).toBe(400);
    expect((await setSettings({ unknownKey: 1 })).status).toBe(400);
    expect((await setSettings({ medicalDirectorId: RANA })).status).toBe(400); // a nurse cannot be medical director
    expect((await setSettings({ fullFeeNoticeH: 30, freeCancelNoticeH: 24 })).status).toBe(400);

    const ok = await setSettings({ noShowFeePct: 40, afterHoursDays: [5, 6] });
    expect(ok.body.changed.sort()).toEqual(['afterHoursDays', 'noShowFeePct']);
    const after = await request(app).get('/api/settings').set('x-staff-id', String(ADMIN));
    expect(after.body.history[0].changed_by_name).toBe('Admin');

    // Survives a restart (new app on the same database).
    app = createApp(db);
    expect((await request(app).get('/api/settings').set('x-staff-id', String(ADMIN))).body.values.noShowFeePct).toBe(40);
    expect((await request(app).post('/api/settings/noShowFeePct/reset').set('x-staff-id', String(ADMIN))).body.values.noShowFeePct).toBe(50);
  });
});

describe('policies follow the settings', () => {
  it('no-show fee: percentage, minimum and cap at the visit price', async () => {
    expect(noShowFee(8_000)).toBe(10_000);
    await setSettings({ noShowCapAtVisitPrice: true });
    expect(noShowFee(8_000)).toBe(8_000);
    await setSettings({ noShowMinFee: 0, noShowFeePct: 25 });
    expect(noShowFee(8_000)).toBe(2_000);
  });

  it('after-hours: Saturday and public holidays when the owner adds them, in Amman time', async () => {
    const saturdayNoon = new Date('2026-11-14T09:00:00Z'); // 12:00 Amman
    expect(isAfterHours(saturdayNoon)).toBe(false);
    await setSettings({ afterHoursDays: [5, 6] });
    expect(isAfterHours(saturdayNoon)).toBe(true);
    const holiday = new Date('2026-11-16T08:00:00Z');
    expect(isAfterHours(holiday)).toBe(false);
    await setSettings({ holidays: ['2026-11-16'] });
    expect(isAfterHours(holiday)).toBe(true);
    expect(isAfterHours(new Date('2026-11-12T18:30:00Z'))).toBe(true); // 21:30 Amman
  });

  it('cancellation fee base: patient share or full price', async () => {
    const id = await acceptedRequest('DOC-VISIT');
    await post(`/api/requests/${id}/schedule`, { route: 'DIRECT', staffId: DOCTOR, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await setSettings({ partialCancelPct: 30 });
    const c = await post(`/api/requests/${id}/cancel`, { reason: 'changed plans', initiatedBy: 'PATIENT' }, COORD, '2026-11-11T20:00:00Z');
    expect(c.body.feePct).toBe(30);
    expect(c.body.fee).toBe(Math.round(35_000 * 0.3));
  });

  it('fee base FULL_PRICE charges on the whole price for insured patients', async () => {
    await setSettings({ feeBase: 'FULL_PRICE' });
    const { body } = await post('/api/requests', { channel: 'CALL_CENTER', patient, items: [{ serviceCode: 'DOC-VISIT' }], insurance: { payerId: 2, memberNo: 'M-9' } }, AGENT);
    db.run(`UPDATE insurance_policies SET covered_codes = '["DOC-VISIT"]', copay_pct = 20`);
    await post(`/api/requests/${body.id}/quote`, { scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/requests/${body.id}/accept`, {}, COORD);
    const s = await post(`/api/requests/${body.id}/schedule`, { route: 'DIRECT', staffId: DOCTOR, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/visits/${s.body.visitId}/dispatch`, {}, DOCTOR);
    const ns = await post(`/api/visits/${s.body.visitId}/no-show`, {}, DOCTOR);
    expect(ns.body.fee).toBe(15_000); // 50% of the 30 JOD insurer price, not of the 6 JOD co-pay
  });

  it('cash direct services paid before booking when the owner requires it', async () => {
    await setSettings({ directServicePayment: 'BEFORE_BOOKING' });
    const id = await acceptedRequest();
    const blocked = await post(`/api/requests/${id}/schedule`, { route: 'DIRECT', staffId: LAB, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/before booking/);
    await post(`/api/requests/${id}/prepayments`, { method: 'LINK', amount: 8_000 }, AGENT);
    expect((await post(`/api/requests/${id}/schedule`, { route: 'DIRECT', staffId: LAB, scheduledAt: '2026-11-12T08:00:00Z' }, COORD)).status).toBe(200);
  });

  it('staff gender preference: warning or hard stop', async () => {
    const id = await acceptedRequest('NRS-VISIT', { preferredStaffGender: 'F' });
    const warn = await post(`/api/requests/${id}/schedule`, { route: 'NURSE', staffId: HADI, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    expect(warn.status).toBe(200);
    expect(warn.body.warnings[0]).toMatch(/female/);
    await setSettings({ genderMatch: 'BLOCK' });
    const id2 = await acceptedRequest('NRS-VISIT', { preferredStaffGender: 'F' });
    expect((await post(`/api/requests/${id2}/schedule`, { route: 'NURSE', staffId: HADI, scheduledAt: '2026-11-13T08:00:00Z' }, COORD)).status).toBe(409);
    expect((await post(`/api/requests/${id2}/schedule`, { route: 'NURSE', staffId: RANA, scheduledAt: '2026-11-13T08:00:00Z' }, COORD)).status).toBe(200);
  });

  it('consent hard stop can be switched off', async () => {
    await setSettings({ requireConsent: false });
    const id = await acceptedRequest();
    const s = await post(`/api/requests/${id}/schedule`, { route: 'DIRECT', staffId: LAB, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/visits/${s.body.visitId}/dispatch`, {}, LAB);
    expect((await post(`/api/visits/${s.body.visitId}/check-in`, HOME, LAB)).status).toBe(200);
  });

  it('escalations call the configured medical director; results wait for the doctor when auto-release is 0', async () => {
    await setSettings({ medicalDirectorId: DOCTOR, resultAutoReleaseH: 0 });
    const id = await acceptedRequest();
    const s = await post(`/api/requests/${id}/schedule`, { route: 'DIRECT', staffId: LAB, scheduledAt: '2026-11-12T08:00:00Z' }, COORD);
    await post(`/api/visits/${s.body.visitId}/dispatch`, {}, LAB);
    await post(`/api/visits/${s.body.visitId}/check-in`, { ...HOME, consent: CONSENT }, LAB, '2026-11-12T08:00:00Z');
    await post(`/api/visits/${s.body.visitId}/complete`, { result: { report: 'K+ 6.9', critical: true } }, LAB, '2026-11-12T08:10:00Z');
    await post('/api/escalations/check-timers', {}, COORD, '2026-11-12T09:00:00Z');
    expect(db.get(`SELECT COUNT(*) AS n FROM notifications WHERE recipient = 'staff:${DOCTOR}' AND message LIKE 'Critical result%not acknowledged%'`)!.n).toBe(1);
    expect(db.get(`SELECT COUNT(*) AS n FROM notifications WHERE recipient = 'role:MEDICAL_DIRECTOR'`)!.n).toBe(0);
  });
});

describe('nursing billed in advance', () => {
  it('bills next week\'s roster, then settles actual attendance and missed shifts on the next run', async () => {
    await setSettings({ nursingBillingMode: 'ADVANCE' });
    const { body: r } = await post('/api/requests', { channel: 'CALL_CENTER', patient, items: [{ serviceCode: 'NRS-HOUR' }] }, AGENT);
    await post(`/api/requests/${r.id}/quote`, {}, COORD);
    await post(`/api/requests/${r.id}/accept`, {}, COORD);
    const { body: s } = await post(`/api/requests/${r.id}/schedule`, { route: 'ASSESSMENT', staffId: DOCTOR, scheduledAt: '2026-11-01T09:00:00Z' }, COORD);
    await post(`/api/visits/${s.visitId}/dispatch`, {}, DOCTOR);
    await post(`/api/visits/${s.visitId}/check-in`, { ...HOME, consent: CONSENT }, DOCTOR, '2026-11-01T09:05:00Z');
    const { body: ep } = await post('/api/episodes', { requestId: r.id, diagnosis: 'Post-op care', suitable: true }, DOCTOR);
    await post(`/api/episodes/${ep.id}/care-plan`, { shiftHours: 8, hoursPerDay: 8, durationDays: 3 }, DOCTOR);
    // Week of Sat 7 Nov → Sat 14 Nov (local). Shifts on 9, 10, 11 Nov, 07:00–15:00 UTC.
    const roster = await post(`/api/episodes/${ep.id}/roster`, { start: '2026-11-09T07:00:00Z', nurseIds: [RANA] }, COORD);
    expect(roster.body.shifts).toBe(3);

    // Run on 8 Nov: bills the coming week (3 × 8 h planned) in advance.
    const first = await post('/api/billing/run', { asOf: '2026-11-08T06:00:00Z' }, FINANCE);
    expect(first.body.created).toHaveLength(1);
    const inv1 = (await request(app).get(`/api/invoices/${first.body.created[0]}`).set('x-staff-id', String(FINANCE))).body;
    expect(inv1.lines.map((l: any) => l.source_type)).toEqual(['SHIFT_PLANNED', 'SHIFT_PLANNED', 'SHIFT_PLANNED']);
    expect(inv1.total).toBe(24 * 6_000);
    expect((await post(`/api/invoices/${inv1.id}/issue`, {}, FINANCE)).status).toBe(200); // planned lines don't trip BR-72

    // Shift 1 worked 6 h (left early), shift 2 missed and nobody covered, shift 3 full.
    const [a, b, c] = roster.body.ids as number[];
    await post(`/api/shifts/${a}/check-in`, HOME, RANA, '2026-11-09T07:00:00Z');
    await post(`/api/shifts/${a}/check-out`, { handover: 'Stable, family present' }, RANA, '2026-11-09T13:00:00Z');
    db.run(`UPDATE shifts SET status = 'MISSED' WHERE id = ?`, b);
    await post(`/api/shifts/${c}/check-in`, HOME, RANA, '2026-11-11T07:00:00Z');
    await post(`/api/shifts/${c}/check-out`, { handover: 'Stable, wound clean' }, RANA, '2026-11-11T15:00:00Z');

    // Run on 15 Nov: next week has no roster, so only the settlement of last week: −2 h and −8 h.
    const second = await post('/api/billing/run', { asOf: '2026-11-15T06:00:00Z' }, FINANCE);
    const inv2 = (await request(app).get(`/api/invoices/${second.body.created[0]}`).set('x-staff-id', String(FINANCE))).body;
    expect(inv2.lines.map((l: any) => [l.source_type, l.qty])).toEqual([['SHIFT_ADJUST', -2], ['SHIFT_ADJUST', -8]]);
    expect(inv2.total).toBe(-10 * 6_000);
  });
});
