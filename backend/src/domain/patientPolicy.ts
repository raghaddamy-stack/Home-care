// Patient cancellation and no-show policy (BRD §5.3, BR-23 / BR-24). Money is integer fils.

/** BR-24: no-show fee is 50% of the visit fee with a 10 JOD minimum. */
export const NO_SHOW_FEE_PCT = 50;
export const NO_SHOW_MIN_FEE = 10_000;
/** BR-24: this many patient no-shows in the look-back window means the next booking must be prepaid. */
export const NO_SHOW_PREPAY_THRESHOLD = 2;
export const NO_SHOW_WINDOW_DAYS = 30;

/** BR-23 notice bands (hours before the scheduled visit). */
export const FREE_CANCEL_NOTICE_H = 24;
export const FULL_FEE_NOTICE_H = 2;

export function noShowFee(visitFee: number): number {
  return Math.max(NO_SHOW_MIN_FEE, Math.round((visitFee * NO_SHOW_FEE_PCT) / 100));
}

export interface CancellationFee {
  pct: 0 | 50 | 100;
  fee: number;
  noticeHours: number;
  reason: string;
}

/**
 * BR-23 patient cancellation fee by notice time:
 * more than 24 h before → free; 24 h to 2 h → 50%; under 2 h, or once the team is on the way → 100%.
 * Cancellations by the company, and cancellations before any visit is booked, are always free.
 */
export function cancellationFee(opts: {
  visitFee: number;
  scheduledAt: Date | null;
  cancelAt: Date;
  initiatedBy: 'PATIENT' | 'COMPANY';
  dispatched?: boolean;
}): CancellationFee {
  const { visitFee, scheduledAt, cancelAt, initiatedBy, dispatched } = opts;
  if (!scheduledAt) return { pct: 0, fee: 0, noticeHours: Infinity, reason: 'No visit booked yet' };
  const noticeHours = (scheduledAt.getTime() - cancelAt.getTime()) / 3600_000;
  if (initiatedBy === 'COMPANY') return { pct: 0, fee: 0, noticeHours, reason: 'Cancelled by the company' };
  let pct: 0 | 50 | 100;
  let reason: string;
  if (dispatched || noticeHours < FULL_FEE_NOTICE_H) {
    pct = 100;
    reason = dispatched ? 'Team already on the way' : `Less than ${FULL_FEE_NOTICE_H} h notice`;
  } else if (noticeHours <= FREE_CANCEL_NOTICE_H) {
    pct = 50;
    reason = `${FULL_FEE_NOTICE_H}–${FREE_CANCEL_NOTICE_H} h notice`;
  } else {
    pct = 0;
    reason = `More than ${FREE_CANCEL_NOTICE_H} h notice`;
  }
  return { pct, fee: Math.round((visitFee * pct) / 100), noticeHours, reason };
}

/** BR-24: true once the patient has reached the no-show threshold inside the window. */
export function prepaymentRequired(noShowDates: Date[], at: Date): boolean {
  const since = at.getTime() - NO_SHOW_WINDOW_DAYS * 86_400_000;
  return noShowDates.filter((d) => d.getTime() >= since && d.getTime() <= at.getTime()).length >= NO_SHOW_PREPAY_THRESHOLD;
}
