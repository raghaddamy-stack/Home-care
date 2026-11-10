// Owner settings screen API. Reading and changing settings needs the ADMIN (owner) role.
import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../db.js';
import { audit, requireRole, wrap } from '../http.js';
import { cfg, DEFAULTS, META, resetSetting, saveSettings } from '../settings.js';

export function settingsRoutes(db: Db): Router {
  const r = Router();

  r.get('/settings', wrap((req) => {
    requireRole(db, req, 'ADMIN');
    const meta = META.map((m) => ({ ...m, default: DEFAULTS[m.key] }));
    return {
      values: cfg(),
      meta,
      staff: db.all(`SELECT id, name, role FROM staff WHERE active = 1 ORDER BY name`),
      history: db.all(
        `SELECT h.*, s.name AS changed_by_name FROM settings_history h LEFT JOIN staff s ON s.id = h.changed_by ORDER BY h.id DESC LIMIT 50`,
      ),
    };
  }));

  r.put('/settings', wrap((req) => {
    const staff = requireRole(db, req, 'ADMIN');
    const patch = z.record(z.unknown()).parse(req.body);
    const out = saveSettings(db, patch, staff.id);
    audit(db, staff.id, 'SETTINGS', 'settings', 0, out.changed);
    return { ...out, values: cfg() };
  }));

  r.post('/settings/:key/reset', wrap((req) => {
    const staff = requireRole(db, req, 'ADMIN');
    const out = resetSetting(db, req.params.key, staff.id);
    return { ...out, values: cfg() };
  }));

  // Values other screens need to show the rules to staff and patients (no secrets here).
  r.get('/settings/public', wrap(() => {
    const s = cfg();
    return {
      coordinatorDiscountLimit: s.coordinatorDiscountLimit,
      afterHoursMultiplier: s.afterHoursMultiplier,
      afterHoursStart: s.afterHoursStart,
      afterHoursEnd: s.afterHoursEnd,
      afterHoursDays: s.afterHoursDays,
      freeCancelNoticeH: s.freeCancelNoticeH,
      fullFeeNoticeH: s.fullFeeNoticeH,
      partialCancelPct: s.partialCancelPct,
      directServicePayment: s.directServicePayment,
      genderMatch: s.genderMatch,
      requireConsent: s.requireConsent,
      checkInGraceMin: s.checkInGraceMin,
    };
  }));

  return r;
}
