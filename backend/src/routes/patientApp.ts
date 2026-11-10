// Patient app: OTP sign-in, booking, quote acceptance, live request tracking, results and invoices.
import { Router, type Request } from 'express';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Db, Row } from '../db.js';
import { HttpError, notify, now, wrap } from '../http.js';
import { CreateRequest, createServiceRequest, missingInfo, setStatus } from './requests.js';

const OTP_TTL_MIN = 5;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_DAYS = 30;
/** Show the code in the API response outside production so demos work without an SMS gateway. */
const EXPOSE_DEV_CODE = process.env.NODE_ENV !== 'production';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const normPhone = (p: string) => p.replace(/[^\d]/g, '').replace(/^(00962|962)/, '0');

export function patientFromToken(db: Db, req: Request): Row {
  const h = req.header('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'Sign in first');
  const s = db.get('SELECT * FROM patient_sessions WHERE token_hash = ?', sha(token));
  if (!s || new Date(s.expires_at) < new Date()) throw new HttpError(401, 'Session expired, sign in again');
  return db.get('SELECT * FROM patients WHERE id = ?', s.patient_id)!;
}

function ownRequest(db: Db, patientId: number, id: string): Row {
  const r = db.get('SELECT * FROM service_requests WHERE id = ? AND patient_id = ?', Number(id), patientId);
  if (!r) throw new HttpError(404, 'Request not found');
  return r;
}

const Profile = z.object({
  dob: z.string().optional(),
  gender: z.enum(['M', 'F']).optional(),
  address: z.string().min(3).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  emergencyContact: z.string().optional(),
});

export function patientAppRoutes(db: Db): Router {
  const r = Router();

  // 1) Ask for a code. Existing patients must use the phone on file; new patients give their name.
  r.post('/patient-auth/request-otp', wrap((req) => {
    const body = z.object({ nationalId: z.string().min(5), phone: z.string().min(9), fullName: z.string().min(2).optional() }).parse(req.body);
    const phone = normPhone(body.phone);
    const existing = db.get('SELECT * FROM patients WHERE national_id = ?', body.nationalId);
    if (existing && existing.phone && normPhone(existing.phone) !== phone) {
      throw new HttpError(400, 'This phone does not match the patient file. Call us to update it.');
    }
    if (!existing && !body.fullName) return { needsName: true };
    const code = String(randomInt(100000, 1000000));
    db.insert('patient_otps', {
      national_id: body.nationalId, phone, full_name: body.fullName, code_hash: sha(code),
      expires_at: new Date(Date.now() + OTP_TTL_MIN * 60_000),
    });
    notify(db, `phone:${phone}`, 'SMS', `Your Home Care code: ${code}`);
    return { sent: true, isNew: !existing, ...(EXPOSE_DEV_CODE ? { devCode: code } : {}) };
  }));

  // 2) Verify the code → session token. Creates the patient file on first sign-in.
  r.post('/patient-auth/verify', wrap((req) => {
    const body = z.object({ nationalId: z.string(), code: z.string().length(6) }).parse(req.body);
    const otp = db.get(`SELECT * FROM patient_otps WHERE national_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1`, body.nationalId);
    if (!otp || new Date(otp.expires_at) < new Date()) throw new HttpError(400, 'Code expired, request a new one');
    if (otp.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, 'Too many attempts, request a new code');
    if (otp.code_hash !== sha(body.code)) {
      db.update('patient_otps', otp.id, { attempts: otp.attempts + 1 });
      throw new HttpError(400, 'Wrong code');
    }
    return db.tx(() => {
      db.update('patient_otps', otp.id, { used_at: new Date() });
      let p = db.get('SELECT * FROM patients WHERE national_id = ?', body.nationalId);
      if (!p) {
        const id = db.insert('patients', { national_id: body.nationalId, full_name: otp.full_name, phone: otp.phone });
        p = db.get('SELECT * FROM patients WHERE id = ?', id)!;
      } else if (!p.phone) db.update('patients', p.id, { phone: otp.phone });
      const token = randomBytes(32).toString('base64url');
      db.insert('patient_sessions', { token_hash: sha(token), patient_id: p.id, expires_at: new Date(Date.now() + SESSION_DAYS * 86_400_000) });
      return { token, patient: { id: p.id, fullName: p.full_name } };
    });
  }));

  r.post('/patient-auth/logout', wrap((req) => {
    const token = (req.header('authorization') ?? '').replace(/^Bearer /, '');
    db.run('DELETE FROM patient_sessions WHERE token_hash = ?', sha(token));
    return { ok: true };
  }));

  // Profile + file. Only released results and the patient's own records.
  r.get('/me', wrap((req) => {
    const p = patientFromToken(db, req);
    return {
      id: p.id, nationalId: p.national_id, fullName: p.full_name, dob: p.dob, gender: p.gender, phone: p.phone,
      address: p.address, lat: p.lat, lng: p.lng, emergencyContact: p.emergency_contact,
      allergies: JSON.parse(p.allergies),
      results: db.all(
        `SELECT r.id, r.report, r.released_at, o.service_code, s.name_ar FROM results r JOIN orders o ON o.id = r.order_id
         JOIN services s ON s.code = o.service_code WHERE r.patient_id = ? AND r.released_at IS NOT NULL ORDER BY r.id DESC`, p.id),
      invoices: db.all(
        `SELECT i.id, i.invoice_no, i.kind, i.total, i.patient_total, i.status, i.created_at, i.period_from, i.period_to,
           COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) AS paid
         FROM invoices i WHERE i.patient_id = ? AND i.status != 'DRAFT' ORDER BY i.id DESC`, p.id),
      rentals: db.all('SELECT id, service_code, serial_no, start_date, expected_return, status FROM rentals WHERE patient_id = ?', p.id),
    };
  }));

  r.post('/me/profile', wrap((req) => {
    const p = patientFromToken(db, req);
    const b = Profile.parse(req.body);
    db.update('patients', p.id, { dob: b.dob, gender: b.gender, address: b.address, lat: b.lat, lng: b.lng, emergency_contact: b.emergencyContact });
    // Requests waiting on missing data move on once the file is complete.
    const waiting = db.all(`SELECT * FROM service_requests WHERE patient_id = ? AND status = 'PENDING_INFO'`, p.id);
    for (const w of waiting) if (missingInfo(db, w).length === 0) setStatus(db, w, 'UNDER_REVIEW', undefined, 'Completed in app');
    return { ok: true };
  }));

  r.post('/me/requests', wrap((req, res) => {
    const p = patientFromToken(db, req);
    const body = CreateRequest.omit({ channel: true, patient: true }).parse(req.body);
    const out = createServiceRequest(db, {
      ...body, channel: 'APP', patient: { nationalId: p.national_id, fullName: p.full_name },
    });
    res.status(201).json(out);
  }));

  // Requests with everything the tracking screen needs.
  r.get('/me/requests', wrap((req) => {
    const p = patientFromToken(db, req);
    const rows = db.all('SELECT * FROM service_requests WHERE patient_id = ? ORDER BY id DESC LIMIT 50', p.id);
    return rows.map((x) => {
      const quote = db.get(`SELECT * FROM quotes WHERE request_id = ? AND status IN ('SENT','ACCEPTED') ORDER BY version DESC LIMIT 1`, x.id);
      const visit = db.get(
        `SELECT v.id, v.kind, v.scheduled_at, v.status, v.otp, s.name AS staff_name, s.role AS staff_role
         FROM visits v JOIN staff s ON s.id = v.staff_id WHERE v.request_id = ? ORDER BY v.id DESC LIMIT 1`, x.id);
      return {
        id: x.id, requestNo: x.request_no, status: x.status, urgency: x.urgency, preferredAt: x.preferred_at, createdAt: x.created_at,
        cancelReason: x.cancel_reason,
        items: db.all(`SELECT i.service_code, i.qty, s.name_ar FROM request_items i JOIN services s ON s.code = i.service_code WHERE request_id = ?`, x.id),
        missing: x.status === 'PENDING_INFO' ? missingInfo(db, x) : [],
        quote: quote && { version: quote.version, lines: JSON.parse(quote.lines), total: quote.total, payerTotal: quote.payer_total, patientTotal: quote.patient_total, status: quote.status },
        // The visit code is shown only once a visit is booked; the patient reads it to the staff on arrival.
        visit: visit && { ...visit, otp: ['SCHEDULED', 'DISPATCHED'].includes(visit.status) ? visit.otp : undefined },
      };
    });
  }));

  r.post('/me/requests/:id/accept', wrap((req) => {
    const p = patientFromToken(db, req);
    const request = ownRequest(db, p.id, req.params.id);
    return db.tx(() => {
      setStatus(db, request, 'ACCEPTED', undefined, 'Accepted in app');
      db.run(`UPDATE quotes SET status = 'ACCEPTED', accepted_at = ? WHERE request_id = ? AND status = 'SENT'`, now(req).toISOString(), request.id);
      notify(db, 'role:COORDINATOR', 'PUSH', `${request.request_no} accepted in app: schedule it`);
      return { status: request.status };
    });
  }));

  r.post('/me/requests/:id/cancel', wrap((req) => {
    const p = patientFromToken(db, req);
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    const request = ownRequest(db, p.id, req.params.id);
    return db.tx(() => {
      setStatus(db, request, 'CANCELLED', undefined, `Patient: ${reason}`);
      db.update('service_requests', request.id, { cancel_reason: reason });
      db.run(`UPDATE quotes SET status = 'REJECTED' WHERE request_id = ? AND status = 'SENT'`, request.id);
      db.run(`UPDATE visits SET status = 'CANCELLED' WHERE request_id = ? AND status = 'SCHEDULED'`, request.id);
      notify(db, 'role:COORDINATOR', 'PUSH', `${request.request_no} cancelled by patient: ${reason}`);
      return { status: request.status };
    });
  }));

  return r;
}
