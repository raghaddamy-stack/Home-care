// ServiceRequest lifecycle (BRD §4.1). Transitions are enforced here only;
// routes call `assertTransition` before writing a new status.

export const REQUEST_STATUSES = [
  'SUBMITTED',
  'PENDING_INFO',
  'UNDER_REVIEW',
  'PENDING_PREAPPROVAL',
  'QUOTED',
  'EXPIRED',
  'ACCEPTED',
  'SCHEDULED',
  'DISPATCHED',
  'IN_PROGRESS',
  'NO_SHOW',
  'COMPLETED',
  'CONVERTED_TO_EPISODE',
  'REFERRED_OUT',
  'CANCELLED',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  SUBMITTED: ['UNDER_REVIEW', 'PENDING_INFO', 'CANCELLED'],
  PENDING_INFO: ['UNDER_REVIEW', 'CANCELLED'],
  UNDER_REVIEW: ['PENDING_INFO', 'PENDING_PREAPPROVAL', 'QUOTED', 'CANCELLED'],
  PENDING_PREAPPROVAL: ['QUOTED', 'CANCELLED'],
  QUOTED: ['QUOTED', 'ACCEPTED', 'EXPIRED', 'CANCELLED'],
  // BR-12: an expired quote is re-priced (new version) or the request is cancelled.
  EXPIRED: ['QUOTED', 'PENDING_PREAPPROVAL', 'CANCELLED'],
  ACCEPTED: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['DISPATCHED', 'SCHEDULED', 'CANCELLED'],
  // BR-23: a patient may still cancel while the team is on the way (100% fee).
  DISPATCHED: ['IN_PROGRESS', 'NO_SHOW', 'CANCELLED'],
  NO_SHOW: ['SCHEDULED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CONVERTED_TO_EPISODE', 'REFERRED_OUT'],
  COMPLETED: [],
  CONVERTED_TO_EPISODE: [],
  REFERRED_OUT: [],
  CANCELLED: [],
};

export class TransitionError extends Error {
  constructor(public from: string, public to: string) {
    super(`Cannot move request from ${from} to ${to}`);
  }
}

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/** Coordinator routing decision (gateway "توجيه الطلب" in the BPMN). */
export const ROUTES = ['DIRECT', 'ASSESSMENT', 'NURSE'] as const;
export type Route = (typeof ROUTES)[number];
