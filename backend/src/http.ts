import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { TransitionError } from './domain/requestStatus.js';
import type { Db, Row } from './db.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);

export function wrap(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      next(e);
    }
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) return res.status(400).json({ error: 'Invalid input', issues: err.issues });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof TransitionError) return res.status(409).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
}

/**
 * Staff identity. Real auth (JWT / SSO) replaces this; for now the client
 * sends `x-staff-id` and we load the staff row.
 */
export function actor(db: Db, req: Request): Row | undefined {
  const id = Number(req.header('x-staff-id'));
  if (!id) return undefined;
  return db.get('SELECT * FROM staff WHERE id = ? AND active = 1', id);
}

export function requireRole(db: Db, req: Request, ...roles: string[]): Row {
  const s = actor(db, req);
  if (!s) throw new HttpError(401, 'Missing or unknown x-staff-id');
  if (!roles.includes(s.role) && s.role !== 'ADMIN') throw new HttpError(403, `Requires role ${roles.join(' or ')}`);
  return s;
}

export function getOr404(db: Db, table: string, id: number | string, label = table): Row {
  const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
  if (!row) throw notFound(label);
  return row;
}

export function notify(db: Db, recipient: string, channel: 'SMS' | 'PUSH' | 'CALL', message: string) {
  db.insert('notifications', { recipient, channel, message });
}

export function audit(db: Db, actorId: number | undefined, action: string, entity: string, entityId: number, detail?: unknown) {
  db.insert('audit_log', { actor_id: actorId, action, entity, entity_id: entityId, detail });
}

export function now(req: Request): Date {
  // Tests and demos can pin the clock with `x-now`.
  const h = req.header('x-now');
  return h ? new Date(h) : new Date();
}
