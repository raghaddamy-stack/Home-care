// Escalation response timers (BRD §5.5). When the first responder has not acknowledged
// before the deadline, the escalation moves up to the next level.

export interface EscalationTimer {
  /** Minutes the first responder has to acknowledge. */
  responseMin: number;
  /** Who is called when the deadline passes. */
  escalateTo: 'MEDICAL_DIRECTOR' | 'SUPERVISOR';
}

/** Critical result: phone the doctor within 30 min of validation, else the medical director. */
export const CRITICAL_RESULT_ACK_MIN = 30;
/** NEWS2 5–6: recheck vitals within 15 min. */
export const NEWS2_RECHECK_MIN = 15;
/** Non-critical results are released to the patient app after doctor review or after 24 h. */
export const RESULT_AUTO_RELEASE_H = 24;

export function timerFor(trigger: string, level: string): EscalationTimer | null {
  if (trigger === 'CRITICAL_RESULT') return { responseMin: CRITICAL_RESULT_ACK_MIN, escalateTo: 'MEDICAL_DIRECTOR' };
  if (trigger === 'NEWS2' && level === 'MEDIUM') return { responseMin: 15, escalateTo: 'MEDICAL_DIRECTOR' };
  if (trigger === 'NEWS2' && level === 'LOW_MEDIUM') return { responseMin: 30, escalateTo: 'MEDICAL_DIRECTOR' };
  // HIGH: the medical director is notified at once (no waiting period).
  if (trigger === 'NEWS2' && level === 'HIGH') return { responseMin: 0, escalateTo: 'MEDICAL_DIRECTOR' };
  // BR-30: no ETA 15 min after the late alert → nursing supervisor.
  if (trigger === 'LATE_SHIFT') return { responseMin: 15, escalateTo: 'SUPERVISOR' };
  return null;
}

export function dueAt(trigger: string, level: string, openedAt: Date): Date | null {
  const t = timerFor(trigger, level);
  return t ? new Date(openedAt.getTime() + t.responseMin * 60_000) : null;
}

/** True when an open escalation has passed its deadline and has not been escalated yet. */
export function isOverdue(e: { status: string; due_at: string | null; escalated_at: string | null }, at: Date): boolean {
  return e.status === 'OPEN' && !!e.due_at && !e.escalated_at && new Date(e.due_at).getTime() <= at.getTime();
}
