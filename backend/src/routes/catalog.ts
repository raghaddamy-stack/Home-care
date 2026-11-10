// Reference data and lookups: services, prices, staff, patients, notifications.
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { getOr404, HttpError, requireRole, wrap } from '../http.js';

export function catalogRoutes(db: Db): Router {
  const r = Router();

  r.get('/services', wrap(() => db.all(
    `SELECT s.*, p.unit_price AS cash_price FROM services s LEFT JOIN price_items p ON p.service_code = s.code AND p.payer_id IS NULL ORDER BY s.line, s.code`,
  )));

  r.get('/payers', wrap(() => db.all('SELECT * FROM payers')));
  r.get('/zones', wrap(() => db.all('SELECT * FROM zones')));

  r.get('/staff', wrap((req) => {
    const role = req.query.role as string | undefined;
    return db.all('SELECT * FROM staff WHERE active = 1 AND (? IS NULL OR role = ?) ORDER BY name', role ?? null, role ?? null);
  }));

  r.post('/staff', wrap((req, res) => {
    requireRole(db, req, 'ADMIN');
    const b = z.object({
      name: z.string(), role: z.string(), gender: z.enum(['M', 'F']).optional(), zoneId: z.number().int().optional(),
      skills: z.array(z.string()).default([]), licenceExpiry: z.string().optional(), phone: z.string().optional(),
    }).parse(req.body);
    const id = db.insert('staff', { name: b.name, role: b.role, gender: b.gender, zone_id: b.zoneId, skills: b.skills, licence_expiry: b.licenceExpiry, phone: b.phone });
    res.status(201).json({ id });
  }));

  // Patient lookup by national ID (intake step "بحث / فتح ملف").
  r.get('/patients', wrap((req) => {
    const nid = req.query.nationalId as string | undefined;
    const q = req.query.q as string | undefined;
    if (nid) {
      const p = db.get('SELECT * FROM patients WHERE national_id = ?', nid);
      if (!p) throw new HttpError(404, 'Patient not found');
      return p;
    }
    return db.all('SELECT * FROM patients WHERE (? IS NULL OR full_name LIKE ? OR phone LIKE ?) ORDER BY id DESC LIMIT 50', q ?? null, `%${q}%`, `%${q}%`);
  }));

  // Patient file: everything about one patient.
  r.get('/patients/:id', wrap((req) => {
    const p = getOr404(db, 'patients', req.params.id, 'Patient');
    return {
      ...p,
      allergies: JSON.parse(p.allergies),
      chronicConditions: JSON.parse(p.chronic_conditions),
      guardians: db.all('SELECT * FROM guardians WHERE patient_id = ?', p.id),
      policies: db.all('SELECT * FROM insurance_policies WHERE patient_id = ?', p.id),
      requests: db.all('SELECT * FROM service_requests WHERE patient_id = ? ORDER BY id DESC', p.id),
      episodes: db.all('SELECT * FROM episodes WHERE patient_id = ? ORDER BY id DESC', p.id),
      results: db.all('SELECT * FROM results WHERE patient_id = ? AND released_at IS NOT NULL ORDER BY id DESC', p.id),
      rentals: db.all('SELECT * FROM rentals WHERE patient_id = ?', p.id),
      invoices: db.all('SELECT * FROM invoices WHERE patient_id = ? ORDER BY id DESC', p.id),
    };
  }));

  r.get('/notifications', wrap((req) => {
    const to = req.query.recipient as string | undefined;
    return db.all('SELECT * FROM notifications WHERE (? IS NULL OR recipient = ?) ORDER BY id DESC LIMIT 100', to ?? null, to ?? null);
  }));

  // Coordinator board feeds.
  r.get('/episodes', wrap((req) => {
    const status = (req.query.status as string | undefined) ?? null;
    return db.all(
      `SELECT e.*, p.full_name, p.address,
         (SELECT shift_hours || 'h × ' || hours_per_day || 'h/day × ' || duration_days || 'd' FROM care_plans c WHERE c.episode_id = e.id ORDER BY version DESC LIMIT 1) AS plan,
         (SELECT COUNT(*) FROM care_plans c WHERE c.episode_id = e.id) AS plan_count,
         (SELECT COUNT(*) FROM shifts s WHERE s.episode_id = e.id AND s.status IN ('PLANNED','LATE','CHECKED_IN')) AS open_shifts
       FROM episodes e JOIN patients p ON p.id = e.patient_id
       WHERE (? IS NULL OR e.status = ?) ORDER BY e.id DESC LIMIT 200`,
      status, status,
    );
  }));

  r.get('/escalations', wrap((req) => {
    const status = (req.query.status as string | undefined) ?? null;
    return db.all(
      `SELECT x.*, e.episode_no, p.full_name FROM escalations x JOIN episodes e ON e.id = x.episode_id JOIN patients p ON p.id = e.patient_id
       WHERE (? IS NULL OR x.status = ?) ORDER BY x.id DESC LIMIT 200`,
      status, status,
    );
  }));

  return r;
}
