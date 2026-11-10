// Patient cancellation and no-show policy (BRD §5.3, BR-23 / BR-24). Money is integer fils.

import { cfg } from '../settings.js';

/** BR-24 no-show fee: a % of the visit fee with a minimum; optionally never above the visit price (owner settings). */
export function noShowFee(visitFee: number): number {
  const s = cfg();
  const fee = Math.max(s.noShowMinFee, Math.round((visitFee * s.noShowFeePct) / 100));
  return s.noShowCapAtVisitPrice ? Math.min(fee, visitFee) : fee;
}

export interface CancellationFee {
  pct: number;
  fee: number;
  noticeHours: number;
  reason: string;
}

/**
 * BR-23 patient cancellation fee by notice time:
 * Bands come from owner settings (defaults: more than 24 h → free; 24 h to 2 h → 50%; under 2 h or dispatched → 100%).
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
  const { fullFeeNoticeH: FULL_FEE_NOTICE_H, freeCancelNoticeH: FREE_CANCEL_NOTICE_H, partialCancelPct } = cfg();
  let pct: number;
  let reason: string;
  if (dispatched || noticeHours < FULL_FEE_NOTICE_H) {
    pct = 100;
    reason = dispatched ? 'Team already on the way' : `Less than ${FULL_FEE_NOTICE_H} h notice`;
  } else if (noticeHours <= FREE_CANCEL_NOTICE_H) {
    pct = partialCancelPct;
    reason = `${FULL_FEE_NOTICE_H}–${FREE_CANCEL_NOTICE_H} h notice`;
  } else {
    pct = 0;
    reason = `More than ${FREE_CANCEL_NOTICE_H} h notice`;
  }
  return { pct, fee: Math.round((visitFee * pct) / 100), noticeHours, reason };
}

/** BR-24: true once the patient has reached the no-show threshold inside the window. */
export function prepaymentRequired(noShowDates: Date[], at: Date): boolean {
  const { noShowWindowDays, noShowPrepayThreshold } = cfg();
  const since = at.getTime() - noShowWindowDays * 86_400_000;
  return noShowDates.filter((d) => d.getTime() >= since && d.getTime() <= at.getTime()).length >= noShowPrepayThreshold;
}
