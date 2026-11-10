// Access control: staff data needs a staff identity; patients only see their own records.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { Db } from '../src/db.js';
import { seed } from '../src/seed.js';

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  const db = new Db(':memory:');
  seed(db);
  app = createApp(db);
});

const STAFF_ONLY_GETS = [
  '/api/patients', '/api/patients/1', '/api/requests', '/api/requests/1', '/api/visits', '/api/episodes', '/api/episodes/1',
  '/api/escalations', '/api/orders', '/api/shifts', '/api/notifications', '/api/invoices', '/api/invoices/1', '/api/patients/1/consents',
  '/api/einvoices', '/api/settings', '/api/integrations', '/api/dashboard/coordinator', '/api/feedback',
];
const STAFF_ONLY_POSTS = ['/api/requests', '/api/requests/expire-quotes', '/api/shifts/check-late', '/api/escalations/check-timers', '/api/billing/run', '/api/einvoices/process'];

describe('access control', () => {
  it.each(STAFF_ONLY_GETS)('GET %s refuses anonymous callers', async (url) => {
    expect((await request(app).get(url)).status).toBe(401);
  });
  it.each(STAFF_ONLY_POSTS)('POST %s refuses anonymous callers', async (url) => {
    expect((await request(app).post(url).send({})).status).toBe(401);
  });
  it('a field nurse cannot run finance or owner actions', async () => {
    const nurse = { 'x-staff-id': '5' };
    expect((await request(app).post('/api/billing/run').set(nurse).send({})).status).toBe(403);
    expect((await request(app).put('/api/settings').set(nurse).send({ noShowFeePct: 0 })).status).toBe(403);
    expect((await request(app).post('/api/integrations/clients').set(nurse).send({ name: 'x', scopes: ['invoices:read'] })).status).toBe(403);
  });
  it('malformed or oversized bodies get a clear 4xx, not a server error', async () => {
    const bad = await request(app).post('/api/requests').set('x-staff-id', '2').set('content-type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    const big = await request(app).post('/api/requests').set('x-staff-id', '2').send({ x: 'a'.repeat(2_000_000) });
    expect(big.status).toBe(413);
  });
  it('the ERP API refuses requests without a key', async () => {
    expect((await request(app).get('/api/erp/v1/invoices')).status).toBe(401);
    expect((await request(app).get('/api/erp/v1/invoices').set('x-staff-id', '1')).status).toBe(401);
  });
});
