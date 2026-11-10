import { cfg } from '../settings.js';
// Escalation response timers (BRD §5.5). When the first responder has not acknowledged
// before the deadline, the escalation moves up to the next level.

export interface EscalationTimer {
  /** Minutes the first responder has to acknowledge. */
  responseMin: number;
  /** Who is called when the deadline passes. */
  escalateTo: 'MEDICAL_DIRECTOR' | 'SUPERVISOR';
}

// Response times come from owner settings (criticalResultAckMin, news2MediumResponseMin,
// news2LowMediumResponseMin, checkInGraceMin); recipients from medicalDirectorId / onCallDoctorIds.

export function timerFor(trigger: string, level: string): EscalationTimer | null {
  if (trigger === 'CRITICAL_RESULT') return { responseMin: cfg().criticalResultAckMin, escalateTo: 'MEDICAL_DIRECTOR' };
  if (trigger === 'NEWS2' && level === 'MEDIUM') return { responseMin: cfg().news2MediumResponseMin, escalateTo: 'MEDICAL_DIRECTOR' };
  if (trigger === 'NEWS2' && level === 'LOW_MEDIUM') return { responseMin: cfg().news2LowMediumResponseMin, escalateTo: 'MEDICAL_DIRECTOR' };
  // HIGH: the medical director is notified at once (no waiting period).
  if (trigger === 'NEWS2' && level === 'HIGH') return { responseMin: 0, escalateTo: 'MEDICAL_DIRECTOR' };
  // BR-30: no ETA 15 min after the late alert → nursing supervisor.
  if (trigger === 'LATE_SHIFT') return { responseMin: cfg().checkInGraceMin, escalateTo: 'SUPERVISOR' };
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
