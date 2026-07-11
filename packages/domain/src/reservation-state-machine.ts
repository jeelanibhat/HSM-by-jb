/**
 * Reservation state machine (TDD §6).
 *
 * "Reservation state transitions follow a strict machine (e.g. CHECKED_IN →
 * CANCELLED is illegal)." This table is the single source of truth; the API
 * enforces it before every write and the DB check constraint backs it up.
 *
 * Terminal states have no outgoing edges. A checked-in guest is never
 * "cancelled" — they check out, or the stay is voided through the folio.
 */
import type { ReservationStatus } from './enums.js';

const TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  // An enquiry is a soft hold: it converts, or it dies.
  ENQUIRY: ['CONFIRMED', 'CANCELLED'],

  // The main path. NO_SHOW is applied by night audit, not by a human.
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],

  // Once in-house, the only way out is out. Cancelling would strand the folio.
  CHECKED_IN: ['CHECKED_OUT'],

  CHECKED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: ReservationStatus,
    readonly to: ReservationStatus,
  ) {
    super(`Illegal reservation transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws IllegalTransitionError. Call this in the use-case before persisting. */
export function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

export function allowedTransitions(from: ReservationStatus): readonly ReservationStatus[] {
  return TRANSITIONS[from];
}

export function isTerminal(status: ReservationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Does this status consume inventory? Cancelled and no-show reservations release
 * their rooms back to the availability counters; everything else holds them.
 * The `no_double_booking` exclusion constraint uses the same predicate.
 */
export function occupiesInventory(status: ReservationStatus): boolean {
  return status !== 'CANCELLED' && status !== 'NO_SHOW';
}

/** Can the stay dates / room types still be edited? */
export function isModifiable(status: ReservationStatus): boolean {
  return status === 'ENQUIRY' || status === 'CONFIRMED' || status === 'CHECKED_IN';
}
