/**
 * Room status machine.
 *
 * Two rules do the real work here:
 *
 *   1. An OCCUPIED room cannot be taken out of order or out of service. There is
 *      a guest in it. A maintenance screen that lets someone click "OOO" on an
 *      in-house room is how a guest gets locked out of their own room, or worse,
 *      gets the room resold under them.
 *
 *   2. OCCUPIED is not a status anyone SETS. It is a consequence of check-in, and
 *      VACANT_DIRTY after it is a consequence of check-out. Both are owned by the
 *      reservations module. Housekeeping and maintenance may move a room between
 *      the vacant states; they may not declare a room occupied.
 *
 * Rule 2 is why `canTransition` is not enough on its own — see assertManualTransition.
 */
import type { RoomStatus } from './enums.js';

const TRANSITIONS: Readonly<Record<RoomStatus, readonly RoomStatus[]>> = {
  // Sellable and ready. Check-in takes it to OCCUPIED.
  VACANT_CLEAN: ['OCCUPIED', 'VACANT_DIRTY', 'OOO', 'OOS'],

  // Needs housekeeping. Still sellable for a FUTURE date — it will be cleaned
  // before the guest arrives — which is why it is not treated as blocked.
  VACANT_DIRTY: ['VACANT_CLEAN', 'OOO', 'OOS'],

  // A guest is in the room. The only way out is check-out.
  OCCUPIED: ['VACANT_DIRTY'],

  // Out of order (maintenance) / out of service (taken off the market).
  OOO: ['VACANT_CLEAN', 'VACANT_DIRTY'],
  OOS: ['VACANT_CLEAN', 'VACANT_DIRTY'],
};

/**
 * Transitions only the reservations module may perform, as a consequence of
 * check-in / check-out. A human clicking a dropdown must never produce these.
 */
const SYSTEM_ONLY: ReadonlyArray<[RoomStatus, RoomStatus]> = [
  ['VACANT_CLEAN', 'OCCUPIED'],
  ['OCCUPIED', 'VACANT_DIRTY'],
];

export class IllegalRoomTransitionError extends Error {
  constructor(
    readonly from: RoomStatus,
    readonly to: RoomStatus,
    reason?: string,
  ) {
    super(reason ?? `Illegal room status transition: ${from} → ${to}`);
    this.name = 'IllegalRoomTransitionError';
  }
}

export function canTransitionRoom(from: RoomStatus, to: RoomStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isSystemOnlyTransition(from: RoomStatus, to: RoomStatus): boolean {
  return SYSTEM_ONLY.some(([f, t]) => f === from && t === to);
}

/**
 * For the reservations module (check-in / check-out). Allows the full table.
 */
export function assertRoomTransition(from: RoomStatus, to: RoomStatus): void {
  if (!canTransitionRoom(from, to)) throw new IllegalRoomTransitionError(from, to);
}

/**
 * For the `updateRoomStatus` mutation — housekeeping, maintenance, front desk.
 *
 * Rejects both illegal transitions AND legal-but-system-owned ones, with a
 * message that says why rather than a bare "illegal transition".
 */
export function assertManualRoomTransition(from: RoomStatus, to: RoomStatus): void {
  if (from === 'OCCUPIED' && (to === 'OOO' || to === 'OOS')) {
    throw new IllegalRoomTransitionError(
      from,
      to,
      'Cannot take an occupied room out of order — check the guest out or move them first.',
    );
  }

  if (isSystemOnlyTransition(from, to)) {
    throw new IllegalRoomTransitionError(
      from,
      to,
      to === 'OCCUPIED'
        ? 'A room becomes OCCUPIED by checking a guest in, not by setting its status.'
        : 'A room is released by checking the guest out, not by setting its status.',
    );
  }

  if (!canTransitionRoom(from, to)) throw new IllegalRoomTransitionError(from, to);
}

export function allowedRoomTransitions(from: RoomStatus): readonly RoomStatus[] {
  return TRANSITIONS[from];
}

/** The transitions a human is allowed to pick from — drives the UI dropdown. */
export function allowedManualRoomTransitions(from: RoomStatus): readonly RoomStatus[] {
  return TRANSITIONS[from].filter(
    (to) =>
      !isSystemOnlyTransition(from, to) && !(from === 'OCCUPIED' && (to === 'OOO' || to === 'OOS')),
  );
}

/**
 * Can this room be sold at all?
 *
 * VACANT_DIRTY counts as sellable: housekeeping will turn it over before the
 * guest arrives. Treating dirty rooms as unsellable would idle most of the
 * inventory every morning. OOO/OOS do not count — they are off the market.
 */
export function isSellable(status: RoomStatus): boolean {
  return status !== 'OOO' && status !== 'OOS';
}

/** Rooms excluded from availability — the `blocked` counter in §4.3. */
export function isBlocked(status: RoomStatus): boolean {
  return status === 'OOO' || status === 'OOS';
}

export function isOccupied(status: RoomStatus): boolean {
  return status === 'OCCUPIED';
}
