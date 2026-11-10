// Consent register (BR-80, BR-03). General consent to home treatment is a hard stop before the first visit.
import { Router } from 'express';
import { z } from 'zod';
import { cfg } from '../settings.js';
import type { Db, Row } from '../db.js';
import {
  CONSENT_METHODS, CONSENT_TYPES, consentsNeededFor, hasValidConsent, SIGNER_RELATIONS, signerError,
  type ConsentMethod, type ConsentType, type SignerRelation,
} from '../domain/consent.js';
import { audit, getOr404, HttpError, now, requireRole, wrap } from '../http.js';

export const ConsentInput = z.object({
  types: z.array(z.enum(CONSENT_TYPES)).min(1).default(['GENERAL_TREATMENT']),
  signedBy: z.string().min(2),
  relation: z.enum(SIGNER_RELATIONS).default('SELF'),
  method: z.enum(CONSENT_METHODS).default('ESIGN'),
  expiresAt: z.string().datetime().optional(),
});

export function recordConsent(
  db: Db,
  patient: Row,
  c: { types: ConsentType[]; signedBy: string; relation: SignerRelation; method: ConsentMethod; at: Date; expiresAt?: string; staffId?: number },
): number[] {
  const err = signerError({ patientDob: patient.dob, relation: c.relation, at: c.at });
  if (err) throw new HttpError(409, err);
  return c.types.map((type) => {
    const id = db.insert('consents', {
      patient_id: patient.id, type, signed_by: c.signedBy, relation: c.relation, method: c.method,
      recorded_by: c.staffId, signed_at: c.at, expires_at: c.expiresAt,
    });
    audit(db, c.staffId, 'CONSENT_SIGNED', 'patients', patient.id, { type, relation: c.relation, method: c.method });
    return id;
  });
}

export function missingConsents(db: Db, patientId: number, needed: ConsentType[], at: Date): ConsentType[] {
  const records = db.all<any>('SELECT * FROM consents WHERE patient_id = ?', patientId);
  return needed.filter((t) => !hasValidConsent(records, t, at));
}

/**
 * Hard stop used at visit and shift check-in. Staff at the door may capture the signature in the same call
 * (`consent` in the body); otherwise a missing consent refuses the check-in.
 */
export function ensureConsent(db: Db, patient: Row, visitKind: string, at: Date, staffId: number, inline?: z.infer<typeof ConsentInput>) {
  if (!cfg().requireConsent) return; // owner turned the hard stop off
  const needed = consentsNeededFor(visitKind);
  let missing = missingConsents(db, patient.id, needed, at);
  if (missing.length && inline) {
    recordConsent(db, patient, { ...inline, types: missing, at, staffId });
    missing = [];
  }
  if (missing.length) throw new HttpError(409, `Consent missing: ${missing.join(', ')}. Get it signed before starting (BR-80)`);
}

export function consentRoutes(db: Db): Router {
  const r = Router();

  r.get('/patients/:id/consents', wrap((req) => {
    const p = getOr404(db, 'patients', req.params.id, 'Patient');
    const t = now(req);
    const rows = db.all<any>('SELECT * FROM consents WHERE patient_id = ? ORDER BY id DESC', p.id);
    return { consents: rows, generalConsent: hasValidConsent(rows, 'GENERAL_TREATMENT', t) };
  }));

  r.post('/patients/:id/consents', wrap((req, res) => {
    const staff = requireRole(db, req, 'AGENT', 'COORDINATOR', 'DOCTOR', 'NURSE', 'LAB_TECH', 'RADIOGRAPHER', 'DRIVER', 'SUPERVISOR');
    const body = ConsentInput.parse(req.body);
    const p = getOr404(db, 'patients', req.params.id, 'Patient');
    // A phone call is not a signature: the call centre may only record consents signed elsewhere (paper scan, OTP).
    if (staff.role === 'AGENT' && body.method === 'ESIGN') throw new HttpError(400, 'Call-centre staff record PAPER or OTP consents only');
    const ids = db.tx(() => recordConsent(db, p, { ...body, at: now(req), staffId: staff.id }));
    res.status(201).json({ ids });
  }));

  r.post('/consents/:id/revoke', wrap((req) => {
    const staff = requireRole(db, req, 'AGENT', 'COORDINATOR', 'DOCTOR', 'SUPERVISOR');
    const c = getOr404(db, 'consents', req.params.id, 'Consent');
    if (c.revoked_at) throw new HttpError(409, 'Consent already revoked');
    db.update('consents', c.id, { revoked_at: now(req) });
    audit(db, staff.id, 'CONSENT_REVOKED', 'patients', c.patient_id, { type: c.type });
    return { revoked: true };
  }));

  return r;
}
