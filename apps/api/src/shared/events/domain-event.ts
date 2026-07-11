/**
 * The Phase 1 event catalog (TDD §6).
 *
 * Events are the ONLY way modules talk to each other about things that happened
 * (TDD §2, principle 3) — check-in emits `reservation.checked_in`; housekeeping
 * and folio react. No cross-module service calls, no cross-module joins.
 */
export const EVENT_TYPES = [
  'reservation.created',
  'reservation.modified',
  'reservation.cancelled',
  'reservation.checked_in',
  'reservation.checked_out',
  'reservation.no_show',
  'folio.line_posted',
  'folio.line_voided',
  'room.status_changed',
  'night_audit.completed',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface DomainEvent<P = Record<string, unknown>> {
  /** Which aggregate produced this — 'reservation', 'folio', 'room'. */
  aggregateType: string;
  aggregateId: string;
  eventType: EventType;
  payload: P;
}

/** An event after it has been persisted to the outbox and picked up by the relay. */
export interface PublishedEvent<P = Record<string, unknown>> extends DomainEvent<P> {
  id: string;
  propertyId: string;
  occurredAt: Date;
}
