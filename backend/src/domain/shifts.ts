// Roster generation and attendance rules (BRD §5.4).

export const SHIFT_PATTERNS = [8, 12, 24] as const;
export type ShiftHours = (typeof SHIFT_PATTERNS)[number];

export const CHECK_IN_GRACE_MIN = 15;
export const BILLING_ROUND_MIN = 15;
export const LATE_TOLERANCE_MIN = 10;

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
  return now.getTime() > plannedStart.getTime() + CHECK_IN_GRACE_MIN * 60_000;
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
  if (lateMin > 0 && lateMin <= LATE_TOLERANCE_MIN && p.checkOut >= p.plannedEnd) from = p.plannedStart.getTime();
  from = Math.max(from, p.plannedStart.getTime());
  const mins = Math.max(0, (to - from) / 60_000);
  return Math.round(mins / BILLING_ROUND_MIN) * BILLING_ROUND_MIN;
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

export const CHECK_IN_RADIUS_M = 150;
