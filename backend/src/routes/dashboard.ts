// Coordinator dashboard: today's KPIs and SLA counters (BRD §7.1) for the board header.
// Read-only. SLA targets live here as product config until the BA moves them into a contract table.
import { Router } from 'express';
import type { Db } from '../db.js';
import { now, requireRole, wrap } from '../http.js';

/** Minutes a request may sit in a status before it counts as late. */
export const SLA_MINUTES = {
  /** App/call request reviewed and priced by a coordinator (BRD §7.1: ≤ 30 min). */
  review: 30,
  /** Pre-approval followed up every 4 h. */
  preapproval: 4 * 60,
  /** Quote sent and not answered: call the patient after 24 h. */
  quote: 24 * 60,
  /** Accepted → staff assigned: same-day / urgent within 3 h, routine within 24 h. */
  scheduleUrgent: 3 * 60,
  scheduleRoutine: 24 * 60,
} as const;

export type SlaKind = 'review' | 'preapproval' | 'quote' | 'schedule';

/** SLA that applies to a request in this status, or null if none. */
export function slaFor(status: string, urgency: string): { kind: SlaKind; minutes: number } | null {
  switch (status) {
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return { kind: 'review', minutes: SLA_MINUTES.review };
    case 'PENDING_PREAPPROVAL':
      return { kind: 'preapproval', minutes: SLA_MINUTES.preapproval };
    case 'QUOTED':
      return { kind: 'quote', minutes: SLA_MINUTES.quote };
    case 'ACCEPTED':
    case 'NO_SHOW':
      return { kind: 'schedule', minutes: urgency === 'ROUTINE' ? SLA_MINUTES.scheduleRoutine : SLA_MINUTES.scheduleUrgent };
    default:
      return null;
  }
}

/** Jordan is UTC+3 all year (no DST since 2022). Returns [start, end) of the local day as ISO strings. */
export function ammanDay(at: Date): [string, string] {
  const OFFSET = 3 * 3600_000;
  const local = new Date(at.getTime() + OFFSET);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET;
  return [new Date(start).toISOString(), new Date(start + 86_400_000).toISOString()];
}

const OPEN_STATUSES = ['SUBMITTED', 'PENDING_INFO', 'UNDER_REVIEW', 'PENDING_PREAPPROVAL', 'QUOTED', 'ACCEPTED', 'NO_SHOW', 'SCHEDULED', 'DISPATCHED', 'IN_PROGRESS'];

export function dashboardRoutes(db: Db): Router {
  const r = Router();

  r.get('/dashboard/coordinator', wrap((req) => {
    requireRole(db, req, 'COORDINATOR', 'SUPERVISOR', 'AGENT');
    const at = now(req);
    const [dayStart, dayEnd] = ammanDay(at);
    const qs = OPEN_STATUSES.map(() => '?').join(',');

    // Time in the current status = time since the last history row.
    const open = db.all<{ id: number; request_no: string; status: string; urgency: string; entered_at: string }>(
      `SELECT r.id, r.request_no, r.status, r.urgency,
         COALESCE((SELECT h.at FROM request_history h WHERE h.request_id = r.id ORDER BY h.id DESC LIMIT 1), r.created_at) AS entered_at
       FROM service_requests r WHERE r.status IN (${qs})`,
      ...OPEN_STATUSES,
    );

    const byStatus = (...s: string[]) => open.filter((x) => s.includes(x.status)).length;
    const overdue = open
      .map((x) => {
        const sla = slaFor(x.status, x.urgency);
        const waited = Math.floor((at.getTime() - new Date(x.entered_at).getTime()) / 60_000);
        return sla && waited > sla.minutes ? { id: x.id, requestNo: x.request_no, kind: sla.kind, waitedMinutes: waited, slaMinutes: sla.minutes } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.waitedMinutes - b.slaMinutes - (a.waitedMinutes - a.slaMinutes));

    const visits = db.get<{ total: number; done: number; inField: number; noShow: number }>(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(status = 'COMPLETED'), 0) AS done,
         COALESCE(SUM(status IN ('DISPATCHED','CHECKED_IN')), 0) AS inField,
         COALESCE(SUM(status = 'NO_SHOW'), 0) AS noShow
       FROM visits WHERE scheduled_at >= ? AND scheduled_at < ? AND status != 'CANCELLED'`,
      dayStart, dayEnd,
    )!;

    const newToday = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM service_requests WHERE created_at >= ? AND created_at < ?', dayStart, dayEnd)!.n;
    const lateShifts = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM shifts WHERE status = 'LATE'`)!.n;
    const openEscalations = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM escalations WHERE status = 'OPEN'`)!.n;
    const since = new Date(at.getTime() - 30 * 86_400_000).toISOString();
    const csat = db.get<{ avg: number | null; n: number; followUps: number }>(
      `SELECT AVG(score) AS avg, COUNT(*) AS n,
         (SELECT COUNT(*) FROM visit_feedback WHERE follow_up = 'OPEN') AS followUps
       FROM visit_feedback WHERE created_at >= ?`,
      since,
    )!;

    return {
      asOf: at.toISOString(),
      queues: {
        toReview: byStatus('SUBMITTED', 'UNDER_REVIEW'),
        pendingInfo: byStatus('PENDING_INFO'),
        preapproval: byStatus('PENDING_PREAPPROVAL'),
        quoted: byStatus('QUOTED'),
        toSchedule: byStatus('ACCEPTED', 'NO_SHOW'),
        urgentOpen: open.filter((x) => x.urgency !== 'ROUTINE').length,
      },
      today: { newRequests: newToday, visits: visits.total, visitsDone: visits.done, inField: visits.inField, noShows: visits.noShow },
      alerts: { lateShifts, openEscalations },
      sla: { overdueCount: overdue.length, overdue: overdue.slice(0, 50) },
      csat: { avg: csat.avg === null ? null : Math.round(csat.avg * 10) / 10, responses: csat.n, openFollowUps: csat.followUps },
    };
  }));

  return r;
}
