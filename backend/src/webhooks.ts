// Business events for the ERP. Every event is stored (so the ERP can poll /api/erp/v1/events) and, when the
// owner configured a webhook URL, delivered by POST with an HMAC-SHA256 signature and retried with back-off.
import { createHmac } from 'node:crypto';
import type { Db } from './db.js';
import { cfg } from './settings.js';

export type EventName = 'invoice.issued' | 'invoice.paid' | 'invoice.voided' | 'payment.created' | 'payer_payment.created' | 'einvoice.accepted' | 'einvoice.rejected' | 'episode.closed' | 'rental.returned';

export function emit(db: Db, event: EventName, data: Record<string, unknown>): number {
  return db.insert('webhook_events', {
    event,
    payload: { event, occurredAt: new Date().toISOString(), data },
    status: cfg().erpWebhookUrl ? 'PENDING' : 'SKIPPED',
  });
}

export function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

const BACKOFF_MIN = [1, 5, 15, 60, 240, 720];

/** Deliver due events. Safe to call often (the server calls it every minute). */
export async function deliverWebhooks(db: Db, fetchImpl: typeof fetch = fetch): Promise<{ sent: number; failed: number }> {
  const { erpWebhookUrl: url, erpWebhookSecret: secret } = cfg();
  if (!url) return { sent: 0, failed: 0 };
  const due = db.all(
    `SELECT * FROM webhook_events WHERE status IN ('PENDING','FAILED') AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY id LIMIT 50`,
    BACKOFF_MIN.length + 1, new Date().toISOString(),
  );
  let sent = 0, failed = 0;
  for (const e of due) {
    const body = e.payload as string;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hc-event': e.event,
          'x-hc-delivery': String(e.id),
          ...(secret ? { 'x-hc-signature': sign(body, secret) } : {}),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      db.update('webhook_events', e.id, { status: 'SENT', sent_at: new Date(), attempts: e.attempts + 1, last_error: null });
      sent++;
    } catch (err) {
      const wait = BACKOFF_MIN[Math.min(e.attempts, BACKOFF_MIN.length - 1)];
      db.update('webhook_events', e.id, {
        status: 'FAILED', attempts: e.attempts + 1, last_error: (err as Error).message.slice(0, 300),
        next_attempt_at: new Date(Date.now() + wait * 60_000),
      });
      failed++;
    }
  }
  return { sent, failed };
}
