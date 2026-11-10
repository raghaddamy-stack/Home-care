// Roster generation and attendance rules (BRD §5.4). Limits come from owner settings.
import { cfg } from '../settings.js';

export const SHIFT_PATTERNS = [8, 12, 24] as const;
export type ShiftHours = (typeof SHIFT_PATTERNS)[number];


export interface PlannedShift {
  start: Date;
  end: Date;
  nurseId: number;
}

/**
 * Build consecutive shifts covering `hoursPerDay` for `days` days starting at `start`.
 * Nurses rotate in the given order so 24h coverage with 8h shifts uses 3 nurses per day.
 */
export function buildRoster(opts: {
  start: Date;
  days: number;
  shiftHours: ShiftHours;
  hoursPerDay: number;
  nurseIds: number[];
}): PlannedShift[] {
  const { start, days, shiftHours, hoursPerDay, nurseIds } = opts;
  if (nurseIds.length === 0) throw new Error('At least one nurse is required');
  if (hoursPerDay % shiftHours !== 0 || hoursPerDay > 24) {
    throw new Error('hoursPerDay must be a multiple of the shift length and at most 24');
  }
  const perDay = hoursPerDay / shiftHours;
  const out: PlannedShift[] = [];
  let k = 0;
  for (let d = 0; d < days; d++) {
    for (let s = 0; s < perDay; s++) {
      const st = new Date(start.getTime() + (d * 24 + s * shiftHours) * 3600_000);
      out.push({ start: st, end: new Date(st.getTime() + shiftHours * 3600_000), nurseId: nurseIds[k++ % nurseIds.length] });
    }
  }
  return out;
}

/** True when a planned shift has passed its grace period without a check-in. */
export function isLate(plannedStart: Date, checkedInAt: Date | null, now: Date): boolean {
  if (checkedInAt) return false;
  return now.getTime() > plannedStart.getTime() + cfg().checkInGraceMin * 60_000;
}

/**
 * Billable minutes = actual attendance rounded to the nearest 15 min (BR-32).
 * Lateness up to 10 min is forgiven when the nurse stayed until the planned end.
 * Time beyond the planned end is not billed (overtime needs pre-approval).
 */
export function billableMinutes(p: { plannedStart: Date; plannedEnd: Date; checkIn: Date; checkOut: Date }): number {
  let from = p.checkIn.getTime();
  const to = Math.min(p.checkOut.getTime(), p.plannedEnd.getTime());
  const lateMin = (from - p.plannedStart.getTime()) / 60_000;
  if (lateMin > 0 && lateMin <= cfg().lateToleranceMin && p.checkOut >= p.plannedEnd) from = p.plannedStart.getTime();
  from = Math.max(from, p.plannedStart.getTime());
  const mins = Math.max(0, (to - from) / 60_000);
  return Math.round(mins / cfg().billingRoundMin) * cfg().billingRoundMin;
}

/** Haversine distance in metres, used for GPS check-in (BR-26: within 150 m). */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}


/** BR-33 nurse working-time limits come from owner settings (minRestHours, maxHoursPer7Days, maxConsecutive24h). */

export interface TimeSlot {
  start: Date;
  end: Date;
}

/**
 * Check one nurse's shifts (existing + proposed) against BR-33. Returns the violations, empty when compliant.
 * - At least 11 h rest between shifts. The only exception is a live-in run of back-to-back 24 h shifts,
 *   capped at 2 in a row.
 * - At most 60 h in any rolling 7-day window.
 */
export function workingTimeViolations(slots: TimeSlot[]): string[] {
  const s = [...slots].sort((a, b) => a.start.getTime() - b.start.getTime());
  const { minRestHours: MIN_REST_HOURS, maxConsecutive24h: MAX_CONSECUTIVE_24H, maxHoursPer7Days: MAX_HOURS_PER_7_DAYS } = cfg();
  const out: string[] = [];
  const h = (ms: number) => ms / 3600_000;
  const len = (x: TimeSlot) => h(x.end.getTime() - x.start.getTime());
  const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

  let chain24 = 0;
  s.forEach((x, i) => {
    if (i === 0) { chain24 = len(x) >= 24 ? 1 : 0; return; }
    const prev = s[i - 1];
    const rest = h(x.start.getTime() - prev.end.getTime());
    if (rest < MIN_REST_HOURS) {
      if (rest === 0 && len(x) >= 24 && len(prev) >= 24) chain24++;
      else out.push(`Only ${Math.max(0, rest)} h rest before the shift at ${fmt(x.start)} (minimum ${MIN_REST_HOURS} h)`);
    } else chain24 = len(x) >= 24 ? 1 : 0;
    if (chain24 > MAX_CONSECUTIVE_24H) out.push(`More than ${MAX_CONSECUTIVE_24H} consecutive 24 h shifts at ${fmt(x.start)}`);
  });

  for (const anchor of s) {
    const from = anchor.start.getTime();
    const to = from + 7 * 86_400_000;
    const hours = s.reduce((a, x) => a + Math.max(0, h(Math.min(x.end.getTime(), to) - Math.max(x.start.getTime(), from))), 0);
    if (hours > MAX_HOURS_PER_7_DAYS) {
      out.push(`${hours} h in the 7 days from ${fmt(anchor.start)} (maximum ${MAX_HOURS_PER_7_DAYS} h)`);
      break;
    }
  }
  return out;
}
