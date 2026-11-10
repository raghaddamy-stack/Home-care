import express from 'express';
import { Db } from './db.js';
import { errorHandler } from './http.js';
import { requestRoutes } from './routes/requests.js';
import { visitRoutes } from './routes/visits.js';
import { clinicalRoutes } from './routes/clinical.js';
import { billingRoutes } from './routes/billing.js';
import { catalogRoutes } from './routes/catalog.js';
import { patientAppRoutes } from './routes/patientApp.js';

export function createApp(db: Db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/requests', requestRoutes(db));
  app.use('/api/visits', visitRoutes(db));
  app.use('/api', clinicalRoutes(db));
  app.use('/api', billingRoutes(db));
  app.use('/api', catalogRoutes(db));
  app.use('/api', patientAppRoutes(db));
  app.use(errorHandler);
  return app;
}
