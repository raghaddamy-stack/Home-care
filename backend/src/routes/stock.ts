// Stock screens: availability before dispensing, goods-issue monitor, and the demo warehouse (MOCK provider).
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { requireRole, requireStaff, wrap, wrapAsync } from '../http.js';
import { cfg } from '../settings.js';
import { checkStock, itemsFor, processStockQueue } from '../stock.js';

export function stockRoutes(db: Db): Router {
  const r = Router();

  // Pharmacist / driver: is it in the store? (shown before pressing "dispense").
  r.post('/stock/check', wrapAsync(async (req) => {
    requireStaff(db, req);
    const b = z.object({
      serviceCode: z.string().optional(), qty: z.number().positive().default(1),
      items: z.array(z.object({ material: z.string().min(1), qty: z.number().positive() })).optional(),
    }).parse(req.body);
    const items = b.items?.length ? b.items : b.serviceCode ? itemsFor(b.serviceCode, b.qty) : [];
    return { provider: cfg().stockProvider, mode: cfg().stockMode, ...(await checkStock(db, items)) };
  }));

  r.get('/stock/movements', wrap((req) => {
    requireRole(db, req, 'FINANCE', 'ADMIN');
    const status = (req.query.status as string | undefined) ?? null;
    return {
      provider: cfg().stockProvider,
      counts: db.all('SELECT status, COUNT(*) AS n FROM stock_movements GROUP BY status'),
      items: db.all(
        `SELECT m.*, p.full_name FROM stock_movements m LEFT JOIN patients p ON p.id = m.patient_id
         WHERE (? IS NULL OR m.status = ?) ORDER BY m.id DESC LIMIT 200`, status, status),
    };
  }));

  r.post('/stock/process', wrapAsync(async (req) => {
    requireRole(db, req, 'FINANCE', 'ADMIN');
    return processStockQueue(db);
  }));

  // Demo warehouse for the MOCK provider.
  r.get('/stock/mock', wrap((req) => {
    requireRole(db, req, 'ADMIN');
    return db.all('SELECT * FROM stock_mock ORDER BY material');
  }));
  r.put('/stock/mock', wrap((req) => {
    requireRole(db, req, 'ADMIN');
    const b = z.object({ material: z.string().min(1).max(40), available: z.number().min(0) }).parse(req.body);
    db.run('INSERT INTO stock_mock (material, available) VALUES (?, ?) ON CONFLICT(material) DO UPDATE SET available = excluded.available', b.material, b.available);
    return b;
  }));

  return r;
}
