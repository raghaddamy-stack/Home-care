import { describe, expect, it } from 'vitest';
import { scoreNews2 } from '../src/domain/news2.js';
import { buildQuote, isAfterHours } from '../src/domain/pricing.js';
import { billableMinutes, buildRoster, isLate } from '../src/domain/shifts.js';
import { buildInvoiceLines, previousPeriod, rentalDaysInPeriod } from '../src/domain/billing.js';
import { canTransition } from '../src/domain/requestStatus.js';

const normal = { respRate: 16, spo2: 97, onOxygen: false, systolicBp: 125, heartRate: 75, consciousness: 'A' as const, temperature: 37 };

describe('NEWS2', () => {
  it('scores normal vitals 0 / routine', () => {
    const r = scoreNews2(normal);
    expect(r.total).toBe(0);
    expect(r.band).toBe('LOW');
  });
  it('flags a single parameter of 3 as urgent review', () => {
    const r = scoreNews2({ ...normal, consciousness: 'V' });
    expect(r.total).toBe(3);
    expect(r.band).toBe('LOW_MEDIUM');
  });
  it('medium band at 5-6', () => {
    const r = scoreNews2({ ...normal, respRate: 22, heartRate: 115, temperature: 38.5 }); // 2 + 2 + 1
    expect(r.total).toBe(5);
    expect(r.band).toBe('MEDIUM');
  });
  it('high band at 7+', () => {
    const r = scoreNews2({ ...normal, respRate: 26, spo2: 90, onOxygen: true, systolicBp: 95 }); // 3+3+2+2
    expect(r.total).toBe(10);
    expect(r.band).toBe('HIGH');
  });
  it('uses scale 2 for hypercapnic patients', () => {
    expect(scoreNews2({ ...normal, spo2: 89, spo2Scale: 2 }).parts.spo2).toBe(0);
    expect(scoreNews2({ ...normal, spo2: 89 }).parts.spo2).toBe(3);
  });
});

describe('pricing', () => {
  const prices = [{ serviceCode: 'A', unitPrice: 10_000 }, { serviceCode: 'B', unitPrice: 50_000 }];
  it('applies discount and co-pay split', () => {
    const q = buildQuote([{ serviceCode: 'A', qty: 2 }, { serviceCode: 'B', qty: 1 }], prices, {
      discountPct: 10, coverage: { copayPct: 20, coveredCodes: ['B'] },
    });
    // A: 20000 - 2000 = 18000 all patient; B: 50000 - 5000 = 45000 → patient 9000
    expect(q.total).toBe(63_000);
    expect(q.patientTotal).toBe(27_000);
    expect(q.payerTotal).toBe(36_000);
  });
  it('caps co-pay', () => {
    const q = buildQuote([{ serviceCode: 'B', qty: 2 }], prices, { coverage: { copayPct: 20, copayCap: 5_000, coveredCodes: ['B'] } });
    expect(q.patientTotal).toBe(5_000);
    expect(q.payerTotal).toBe(95_000);
  });
  it('adds after-hours multiplier', () => {
    const night = new Date(2026, 10, 10, 22, 0);
    expect(isAfterHours(night)).toBe(true);
    expect(buildQuote([{ serviceCode: 'A', qty: 1 }], prices, { scheduledAt: night }).total).toBe(12_500);
  });
});

describe('shifts', () => {
  it('builds 24h coverage from 8h shifts rotating nurses', () => {
    const r = buildRoster({ start: new Date('2026-11-10T07:00:00Z'), days: 2, shiftHours: 8, hoursPerDay: 24, nurseIds: [1, 2, 3] });
    expect(r).toHaveLength(6);
    expect(r[1].start.toISOString()).toBe('2026-11-10T15:00:00.000Z');
    expect(r.map((s) => s.nurseId)).toEqual([1, 2, 3, 1, 2, 3]);
  });
  it('rejects patterns that do not fit the day', () => {
    expect(() => buildRoster({ start: new Date(), days: 1, shiftHours: 12, hoursPerDay: 8, nurseIds: [1] })).toThrow();
  });
  it('detects late check-in after 15 minutes', () => {
    const start = new Date('2026-11-10T07:00:00Z');
    expect(isLate(start, null, new Date('2026-11-10T07:14:00Z'))).toBe(false);
    expect(isLate(start, null, new Date('2026-11-10T07:16:00Z'))).toBe(true);
  });
  it('bills actual attendance rounded to 15 min, forgiving 10 min lateness', () => {
    const plannedStart = new Date('2026-11-10T07:00:00Z');
    const plannedEnd = new Date('2026-11-10T15:00:00Z');
    expect(billableMinutes({ plannedStart, plannedEnd, checkIn: new Date('2026-11-10T07:08:00Z'), checkOut: new Date('2026-11-10T15:05:00Z') })).toBe(480);
    expect(billableMinutes({ plannedStart, plannedEnd, checkIn: new Date('2026-11-10T07:40:00Z'), checkOut: new Date('2026-11-10T15:00:00Z') })).toBe(435);
  });
});

describe('billing', () => {
  it('weekly period is the previous Saturday-to-Saturday week', () => {
    const asOf = new Date(2026, 10, 10);
    const p = previousPeriod('WEEKLY', asOf);
    expect(p.from.getDay()).toBe(6);
    expect(p.to.getDay()).toBe(6);
    expect((p.to.getTime() - p.from.getTime()) / 86_400_000).toBe(7);
    expect(p.to <= asOf && asOf.getTime() - p.to.getTime() < 7 * 86_400_000).toBe(true);
  });
  it('monthly period is the previous calendar month', () => {
    const p = previousPeriod('MONTHLY', new Date(2026, 10, 10));
    expect(p.from).toEqual(new Date(2026, 9, 1));
    expect(p.to).toEqual(new Date(2026, 10, 1));
  });
  it('splits invoice lines by co-pay', () => {
    const [l] = buildInvoiceLines([{ sourceType: 'SHIFT', sourceId: 1, description: 'x', qty: 8, unitPrice: 6_000 }], 20);
    expect(l.amount).toBe(48_000);
    expect(l.patientAmount).toBe(9_600);
    expect(l.payerAmount).toBe(38_400);
  });
  it('counts rental days inside a period', () => {
    const p = { from: new Date('2026-11-01'), to: new Date('2026-11-08') };
    expect(rentalDaysInPeriod(new Date('2026-10-20'), null, p)).toBe(7);
    expect(rentalDaysInPeriod(new Date('2026-11-05'), new Date('2026-11-07'), p)).toBe(2);
  });
});

describe('request lifecycle', () => {
  it('only allows defined transitions', () => {
    expect(canTransition('QUOTED', 'ACCEPTED')).toBe(true);
    expect(canTransition('SUBMITTED', 'SCHEDULED')).toBe(false);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
  });
});
