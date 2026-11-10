// Patient satisfaction after a finished visit (BRD §7.2 Experience: CSAT after visit).
// Patients rate once per request; low scores open a follow-up for the supervisor.
import { Router } from 'express';
import { z } from 'zod';
import { cfg } from '../settings.js';
import type { Db } from '../db.js';
import { audit, HttpError, notify, now, requireRole, wrap } from '../http.js';
import { patientFromToken } from './patientApp.js';

// Low-score threshold and rating window come from owner settings (feedbackLowScore, feedbackWindowDays).
const RATEABLE = ['COMPLETED', 'CONVERTED_TO_EPISODE', 'REFERRED_OUT'];

export const FEEDBACK_TAGS = ['ON_TIME', 'LATE', 'KIND_STAFF', 'CLEAR_EXPLANATION', 'PAIN', 'PRICE', 'HYGIENE', 'COMMUNICATION'] as const;

const Rating = z.object({
  score: z.number().int().min(1).max(5),
  tags: z.array(z.enum(FEEDBACK_TAGS)).max(8).default([]),
  comment: z.string().trim().max(1000).optional(),
});

/** Last finished visit on the request: who served the patient and when. */
function lastVisit(db: Db, requestId: number) {
  return db.get<{ staff_id: number; staff_name: string; completed_at: string | null; kind: string }>(
    `SELECT v.staff_id, s.name AS staff_name, v.completed_at, v.kind FROM visits v JOIN staff s ON s.id = v.staff_id
     WHERE v.request_id = ? AND v.status = 'COMPLETED' ORDER BY v.id DESC LIMIT 1`,
    requestId,
  );
}

export function feedbackRoutes(db: Db): Router {
  const r = Router();

  // Patient: finished requests still waiting for a rating (inside the window).
  r.get('/me/feedback/pending', wrap((req) => {
    const p = patientFromToken(db, req);
    const since = new Date(now(req).getTime() - cfg().feedbackWindowDays * 86_400_000).toISOString();
    const rows = db.all(
      `SELECT r.id, r.request_no, r.status FROM service_requests r
       WHERE r.patient_id = ? AND r.status IN (${RATEABLE.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM visit_feedback f WHERE f.request_id = r.id)
       ORDER BY r.id DESC LIMIT 5`,
      p.id, ...RATEABLE,
    );
    return rows
      .map((x) => {
        const v = lastVisit(db, x.id);
        return v && (!v.completed_at || v.completed_at >= since)
          ? {
              requestId: x.id, requestNo: x.request_no, staffName: v.staff_name, visitKind: v.kind, completedAt: v.completed_at,
              services: db.all<{ name_ar: string }>(`SELECT s.name_ar FROM request_items i JOIN services s ON s.code = i.service_code WHERE i.request_id = ?`, x.id).map((s) => s.name_ar),
            }
          : null;
      })
      .filter(Boolean);
  }));

  r.post('/me/requests/:id/rating', wrap((req, res) => {
    const p = patientFromToken(db, req);
    const body = Rating.parse(req.body);
    const request = db.get('SELECT * FROM service_requests WHERE id = ? AND patient_id = ?', Number(req.params.id), p.id);
    if (!request) throw new HttpError(404, 'Request not found');
    if (!RATEABLE.includes(request.status)) throw new HttpError(409, 'You can rate a visit once it is finished');
    if (db.get('SELECT 1 FROM visit_feedback WHERE request_id = ?', request.id)) throw new HttpError(409, 'Already rated, thank you');
    const v = lastVisit(db, request.id);
    const low = body.score <= cfg().feedbackLowScore;
    const id = db.insert('visit_feedback', {
      request_id: request.id, patient_id: p.id, staff_id: v?.staff_id, score: body.score, tags: body.tags,
      comment: body.comment || undefined, follow_up: low ? 'OPEN' : 'NONE', created_at: now(req),
    });
    if (low) notify(db, 'role:SUPERVISOR', 'PUSH', `Low rating (${body.score}/5) on ${request.request_no}: call the patient`);
    res.status(201).json({ id, followUp: low });
  }));

  // Staff: recent ratings, optionally only open follow-ups.
  r.get('/feedback', wrap((req) => {
    requireRole(db, req, 'COORDINATOR', 'SUPERVISOR');
    const open = req.query.followUp === 'OPEN';
    return db.all(
      `SELECT f.*, r.request_no, p.full_name, p.phone, s.name AS staff_name FROM visit_feedback f
       JOIN service_requests r ON r.id = f.request_id JOIN patients p ON p.id = f.patient_id
       LEFT JOIN staff s ON s.id = f.staff_id
       ${open ? `WHERE f.follow_up = 'OPEN'` : ''} ORDER BY f.id DESC LIMIT 100`,
    ).map((f) => ({ ...f, tags: JSON.parse(f.tags) }));
  }));

  r.post('/feedback/:id/close', wrap((req) => {
    const staff = requireRole(db, req, 'COORDINATOR', 'SUPERVISOR');
    const { note } = z.object({ note: z.string().trim().min(3) }).parse(req.body);
    const f = db.get('SELECT * FROM visit_feedback WHERE id = ?', Number(req.params.id));
    if (!f) throw new HttpError(404, 'Feedback not found');
    if (f.follow_up !== 'OPEN') throw new HttpError(409, 'No open follow-up on this rating');
    db.update('visit_feedback', f.id, { follow_up: 'CLOSED', follow_up_note: note, closed_by: staff.id, closed_at: now(req) });
    audit(db, staff.id, 'feedback.close', 'visit_feedback', f.id, { note });
    return { ok: true };
  }));

  return r;
}
