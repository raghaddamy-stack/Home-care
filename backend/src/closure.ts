// Closing a home-care account: discharged, every device back, and every invoice settled by the patient.
import type { Db } from './db.js';
import { notify } from './http.js';
import { emit } from './webhooks.js';

/** Returns true when the episode's account is (now) closed. Safe to call after any payment or device return. */
export function maybeCloseEpisode(db: Db, episodeId: number | null | undefined): boolean {
  if (!episodeId) return false;
  const ep = db.get('SELECT * FROM episodes WHERE id = ?', episodeId);
  if (!ep || ep.closed_at) return !!ep?.closed_at;
  if (ep.status !== 'DISCHARGED') return false;
  if (db.get(`SELECT 1 FROM rentals WHERE episode_id = ? AND status = 'ACTIVE'`, ep.id)) return false;
  if (!ep.final_billed_at) return false;
  // Every invoice must be issued (finance reviewed) and settled by the patient.
  if (db.get(`SELECT 1 FROM invoices WHERE episode_id = ? AND status = 'DRAFT'`, ep.id)) return false;
  const open = db.get(
    `SELECT 1 FROM invoices i WHERE i.episode_id = ? AND i.status NOT IN ('VOID','DRAFT') AND i.patient_total > 0
       AND COALESCE((SELECT SUM(amount) FROM payments p WHERE p.invoice_id = i.id), 0) < i.patient_total`,
    ep.id,
  );
  if (open) return false;
  db.update('episodes', ep.id, { closed_at: new Date() });
  emit(db, 'episode.closed', { episodeId: ep.id, episodeNo: ep.episode_no, patientId: ep.patient_id });
  notify(db, `patient:${ep.patient_id}`, 'SMS', 'Your home-care account is closed. Thank you, and please rate our service.');
  return true;
}
