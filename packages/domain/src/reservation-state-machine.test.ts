import { describe, expect, it } from 'vitest';
import { RESERVATION_STATUSES, type ReservationStatus } from './enums.js';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isModifiable,
  isTerminal,
  occupiesInventory,
} from './reservation-state-machine.js';

/**
 * TDD §8.2: "Reservation state machine: every legal + illegal transition."
 * We assert the full 6×6 matrix, not a sample — a silently-widened transition
 * table is exactly the bug that lets a checked-in guest be cancelled.
 */
const LEGAL: ReadonlyArray<[ReservationStatus, ReservationStatus]> = [
  ['ENQUIRY', 'CONFIRMED'],
  ['ENQUIRY', 'CANCELLED'],
  ['CONFIRMED', 'CHECKED_IN'],
  ['CONFIRMED', 'CANCELLED'],
  ['CONFIRMED', 'NO_SHOW'],
  ['CHECKED_IN', 'CHECKED_OUT'],
];

const isLegal = (from: ReservationStatus, to: ReservationStatus) =>
  LEGAL.some(([f, t]) => f === from && t === to);

describe('reservation state machine', () => {
  describe('full transition matrix', () => {
    for (const from of RESERVATION_STATUSES) {
      for (const to of RESERVATION_STATUSES) {
        const legal = isLegal(from, to);
        it(`${legal ? 'allows' : 'rejects'} ${from} → ${to}`, () => {
          expect(canTransition(from, to)).toBe(legal);
        });
      }
    }
  });

  it('rejects self-transitions for every status', () => {
    for (const s of RESERVATION_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('throws IllegalTransitionError with both states on the error', () => {
    expect(() => assertTransition('CHECKED_IN', 'CANCELLED')).toThrow(IllegalTransitionError);

    try {
      assertTransition('CHECKED_IN', 'CANCELLED');
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as IllegalTransitionError;
      expect(e.from).toBe('CHECKED_IN');
      expect(e.to).toBe('CANCELLED');
      expect(e.message).toContain('CHECKED_IN → CANCELLED');
    }
  });

  it('does not throw on a legal transition', () => {
    expect(() => assertTransition('CONFIRMED', 'CHECKED_IN')).not.toThrow();
  });

  it('treats CHECKED_OUT, CANCELLED and NO_SHOW as terminal', () => {
    expect(isTerminal('CHECKED_OUT')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('NO_SHOW')).toBe(true);

    expect(isTerminal('ENQUIRY')).toBe(false);
    expect(isTerminal('CONFIRMED')).toBe(false);
    expect(isTerminal('CHECKED_IN')).toBe(false);
  });

  it('never allows a transition out of a terminal state', () => {
    for (const from of RESERVATION_STATUSES.filter(isTerminal)) {
      expect(allowedTransitions(from)).toEqual([]);
      for (const to of RESERVATION_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  // The rule that protects the folio: an in-house guest has charges posted
  // against them, so cancellation must go through check-out.
  it('never allows CHECKED_IN to be cancelled or marked no-show', () => {
    expect(canTransition('CHECKED_IN', 'CANCELLED')).toBe(false);
    expect(canTransition('CHECKED_IN', 'NO_SHOW')).toBe(false);
    expect(allowedTransitions('CHECKED_IN')).toEqual(['CHECKED_OUT']);
  });

  it('never allows a reservation to skip straight from ENQUIRY to CHECKED_IN', () => {
    expect(canTransition('ENQUIRY', 'CHECKED_IN')).toBe(false);
  });

  it('never allows a checked-out stay to be reopened', () => {
    expect(canTransition('CHECKED_OUT', 'CHECKED_IN')).toBe(false);
  });
});

describe('occupiesInventory', () => {
  it('holds inventory for live reservations', () => {
    expect(occupiesInventory('ENQUIRY')).toBe(true);
    expect(occupiesInventory('CONFIRMED')).toBe(true);
    expect(occupiesInventory('CHECKED_IN')).toBe(true);
    expect(occupiesInventory('CHECKED_OUT')).toBe(true);
  });

  // Must match the WHERE clause of the no_double_booking exclusion constraint.
  it('releases inventory for CANCELLED and NO_SHOW only', () => {
    expect(occupiesInventory('CANCELLED')).toBe(false);
    expect(occupiesInventory('NO_SHOW')).toBe(false);
  });
});

describe('isModifiable', () => {
  it('allows edits up to and including check-in', () => {
    expect(isModifiable('ENQUIRY')).toBe(true);
    expect(isModifiable('CONFIRMED')).toBe(true);
    expect(isModifiable('CHECKED_IN')).toBe(true); // extend stay / room move
  });

  it('freezes terminal reservations', () => {
    expect(isModifiable('CHECKED_OUT')).toBe(false);
    expect(isModifiable('CANCELLED')).toBe(false);
    expect(isModifiable('NO_SHOW')).toBe(false);
  });
});
