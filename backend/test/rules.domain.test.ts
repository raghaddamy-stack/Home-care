// Unit tests for the business rules added in the BA gap-analysis round (docs/ba-gap-analysis.md).
import { describe, expect, it } from 'vitest';
import { isQuoteExpired, quoteValidUntil } from '../src/domain/pricing.js';
import { cancellationFee, noShowFee, prepaymentRequired } from '../src/domain/patientPolicy.js';
import { hasValidConsent, signerError } from '../src/domain/consent.js';
import { dueAt, isOverdue, timerFor } from '../src/domain/escalation.js';
import { workingTimeViolations } from '../src/domain/shifts.js';
import { canTransition } from '../src/domain/requestStatus.js';

const T = new Date('2026-11-10T08:00:00Z');
const hours = (n: number) => new Date(T.getTime() + n * 3600_000);

describe('BR-12 quote validity', () => {
  it('is 48 h for routine and 4 h for same-day / urgent', () => {
    expect(quoteValidUntil(T, 'ROUTINE')).toEqual(hours(48));
    expect(quoteValidUntil(T, 'SAME_DAY')).toEqual(hours(4));
    expect(quoteValidUntil(T, 'URGENT')).toEqual(hours(4));
  });
  it('expires only after the validity; legacy quotes without validity never expire', () => {
    expect(isQuoteExpired(hours(48), hours(47))).toBe(false);
    expect(isQuoteExpired(hours(48), hours(49))).toBe(true);
    expect(isQuoteExpired(null, hours(1000))).toBe(false);
  });
  it('EXPIRED can be re-quoted or cancelled but not accepted', () => {
    expect(canTransition('QUOTED', 'EXPIRED')).toBe(true);
    expect(canTransition('EXPIRED', 'QUOTED')).toBe(true);
    expect(canTransition('EXPIRED', 'CANCELLED')).toBe(true);
    expect(canTransition('EXPIRED', 'ACCEPTED')).toBe(false);
  });
});

describe('BR-23 cancellation fee by notice', () => {
  const fee = (h: number, extra: Partial<Parameters<typeof cancellationFee>[0]> = {}) =>
    cancellationFee({ visitFee: 20_000, scheduledAt: hours(h), cancelAt: T, initiatedBy: 'PATIENT', ...extra });
  it('is free with more than 24 h notice', () => expect(fee(30).fee).toBe(0));
  it('is 50% between 24 h and 2 h', () => {
    expect(fee(24).pct).toBe(50);
    expect(fee(10).fee).toBe(10_000);
    expect(fee(2).pct).toBe(50);
  });
  it('is 100% under 2 h or once the team is on the way', () => {
    expect(fee(1).fee).toBe(20_000);
    expect(fee(10, { dispatched: true }).pct).toBe(100);
  });
  it('is never charged when the company cancels or nothing was booked', () => {
    expect(fee(1, { initiatedBy: 'COMPANY' }).fee).toBe(0);
    expect(cancellationFee({ visitFee: 20_000, scheduledAt: null, cancelAt: T, initiatedBy: 'PATIENT' }).fee).toBe(0);
  });
});

describe('BR-24 no-show', () => {
  it('fee is 50% with a 10 JOD minimum', () => {
    expect(noShowFee(35_000)).toBe(17_500);
    expect(noShowFee(8_000)).toBe(10_000);
  });
  it('second no-show within 30 days requires prepayment', () => {
    expect(prepaymentRequired([hours(-24)], T)).toBe(false);
    expect(prepaymentRequired([hours(-24), hours(-24 * 20)], T)).toBe(true);
    expect(prepaymentRequired([hours(-24), hours(-24 * 31)], T)).toBe(false);
  });
});

describe('BR-80 / BR-03 consent', () => {
  it('a minor cannot sign for themself; a guardian can', () => {
    expect(signerError({ patientDob: '2015-05-01', relation: 'SELF', at: T })).toMatch(/guardian/);
    expect(signerError({ patientDob: '2015-05-01', relation: 'PARENT', at: T })).toBeNull();
    expect(signerError({ patientDob: '1950-05-01', relation: 'SELF', at: T })).toBeNull();
  });
  it('revoked, expired or future-dated consents do not count', () => {
    const base = { type: 'GENERAL_TREATMENT', signed_at: hours(-1).toISOString(), expires_at: null, revoked_at: null };
    expect(hasValidConsent([base], 'GENERAL_TREATMENT', T)).toBe(true);
    expect(hasValidConsent([{ ...base, revoked_at: T.toISOString() }], 'GENERAL_TREATMENT', T)).toBe(false);
    expect(hasValidConsent([{ ...base, expires_at: hours(-0.5).toISOString() }], 'GENERAL_TREATMENT', T)).toBe(false);
    expect(hasValidConsent([{ ...base, signed_at: hours(1).toISOString() }], 'GENERAL_TREATMENT', T)).toBe(false);
    expect(hasValidConsent([base], 'IMAGING', T)).toBe(false);
  });
});

describe('§5.5 escalation timers', () => {
  it('critical result: 30 min, then the medical director', () => {
    expect(timerFor('CRITICAL_RESULT', 'CRITICAL')).toEqual({ responseMin: 30, escalateTo: 'MEDICAL_DIRECTOR' });
    expect(dueAt('CRITICAL_RESULT', 'CRITICAL', T)).toEqual(hours(0.5));
  });
  it('NEWS2 5–6: 15 min; single 3: 30 min; incidents have no timer', () => {
    expect(dueAt('NEWS2', 'MEDIUM', T)).toEqual(hours(0.25));
    expect(dueAt('NEWS2', 'LOW_MEDIUM', T)).toEqual(hours(0.5));
    expect(dueAt('INCIDENT', 'REVIEW', T)).toBeNull();
  });
  it('is overdue only while open and not yet escalated', () => {
    const e = { status: 'OPEN', due_at: hours(0.25).toISOString(), escalated_at: null };
    expect(isOverdue(e, hours(0.2))).toBe(false);
    expect(isOverdue(e, hours(0.3))).toBe(true);
    expect(isOverdue({ ...e, status: 'ACKED' }, hours(1))).toBe(false);
    expect(isOverdue({ ...e, escalated_at: hours(0.3).toISOString() }, hours(1))).toBe(false);
  });
});

describe('BR-33 nurse working time', () => {
  const shift = (startH: number, len: number) => ({ start: hours(startH), end: hours(startH + len) });
  it('accepts 12 h on / 12 h off', () => {
    expect(workingTimeViolations([shift(0, 12), shift(24, 12), shift(48, 12)])).toEqual([]);
  });
  it('needs 11 h rest between shifts', () => {
    expect(workingTimeViolations([shift(0, 8), shift(16, 8)])[0]).toMatch(/8 h rest/);
    expect(workingTimeViolations([shift(0, 8), shift(8, 8)])[0]).toMatch(/0 h rest/);
  });
  it('allows at most 2 back-to-back 24 h shifts', () => {
    expect(workingTimeViolations([shift(0, 24), shift(24, 24)])).toEqual([]);
    expect(workingTimeViolations([shift(0, 24), shift(24, 24), shift(48, 24)]).join()).toMatch(/consecutive 24 h/);
  });
  it('caps 60 h in any 7 days', () => {
    const six = [0, 1, 2, 3, 4, 5].map((d) => shift(d * 24, 12)); // 72 h
    expect(workingTimeViolations(six).join()).toMatch(/72 h in the 7 days/);
    expect(workingTimeViolations(six.slice(0, 5))).toEqual([]); // 60 h is allowed
  });
});
