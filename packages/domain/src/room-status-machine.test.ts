import { describe, expect, it } from 'vitest';
import { ROOM_STATUSES, type RoomStatus } from './enums.js';
import {
  allowedManualRoomTransitions,
  allowedRoomTransitions,
  assertManualRoomTransition,
  assertRoomTransition,
  canTransitionRoom,
  IllegalRoomTransitionError,
  isBlocked,
  isOccupied,
  isSellable,
  isSystemOnlyTransition,
} from './room-status-machine.js';

const LEGAL: ReadonlyArray<[RoomStatus, RoomStatus]> = [
  ['VACANT_CLEAN', 'OCCUPIED'],
  ['VACANT_CLEAN', 'VACANT_DIRTY'],
  ['VACANT_CLEAN', 'OOO'],
  ['VACANT_CLEAN', 'OOS'],
  ['VACANT_DIRTY', 'VACANT_CLEAN'],
  ['VACANT_DIRTY', 'OOO'],
  ['VACANT_DIRTY', 'OOS'],
  ['OCCUPIED', 'VACANT_DIRTY'],
  ['OOO', 'VACANT_CLEAN'],
  ['OOO', 'VACANT_DIRTY'],
  ['OOS', 'VACANT_CLEAN'],
  ['OOS', 'VACANT_DIRTY'],
];

const isLegal = (f: RoomStatus, t: RoomStatus) => LEGAL.some(([a, b]) => a === f && b === t);

describe('room status machine — full matrix', () => {
  for (const from of ROOM_STATUSES) {
    for (const to of ROOM_STATUSES) {
      const legal = isLegal(from, to);
      it(`${legal ? 'allows' : 'rejects'} ${from} → ${to}`, () => {
        expect(canTransitionRoom(from, to)).toBe(legal);
      });
    }
  }

  it('rejects every self-transition', () => {
    for (const s of ROOM_STATUSES) {
      expect(canTransitionRoom(s, s)).toBe(false);
    }
  });
});

/**
 * THE safety rule. A guest is asleep in that room.
 */
describe('an occupied room cannot be taken out of order', () => {
  it('rejects OCCUPIED → OOO with an explanation, not a bare error', () => {
    expect(() => assertManualRoomTransition('OCCUPIED', 'OOO')).toThrow(
      /occupied room out of order/i,
    );
  });

  it('rejects OCCUPIED → OOS', () => {
    expect(() => assertManualRoomTransition('OCCUPIED', 'OOS')).toThrow(
      IllegalRoomTransitionError,
    );
  });

  it('does not even list OOO/OOS as options for an occupied room', () => {
    expect(allowedManualRoomTransitions('OCCUPIED')).not.toContain('OOO');
    expect(allowedManualRoomTransitions('OCCUPIED')).not.toContain('OOS');
  });

  it('leaves check-out as the only way out of OCCUPIED', () => {
    expect(allowedRoomTransitions('OCCUPIED')).toEqual(['VACANT_DIRTY']);
  });
});

/**
 * Occupancy is a CONSEQUENCE of check-in, never something a human sets.
 */
describe('occupancy is owned by the reservations module', () => {
  it('flags the two occupancy transitions as system-only', () => {
    expect(isSystemOnlyTransition('VACANT_CLEAN', 'OCCUPIED')).toBe(true);
    expect(isSystemOnlyTransition('OCCUPIED', 'VACANT_DIRTY')).toBe(true);
  });

  it('does not flag housekeeping moves as system-only', () => {
    expect(isSystemOnlyTransition('VACANT_DIRTY', 'VACANT_CLEAN')).toBe(false);
    expect(isSystemOnlyTransition('VACANT_CLEAN', 'OOO')).toBe(false);
  });

  it('refuses a manual VACANT_CLEAN → OCCUPIED, pointing at check-in', () => {
    expect(() => assertManualRoomTransition('VACANT_CLEAN', 'OCCUPIED')).toThrow(
      /checking a guest in/i,
    );
  });

  it('refuses a manual OCCUPIED → VACANT_DIRTY, pointing at check-out', () => {
    expect(() => assertManualRoomTransition('OCCUPIED', 'VACANT_DIRTY')).toThrow(
      /checking the guest out/i,
    );
  });

  it('ALLOWS the same transitions for the system (check-in / check-out)', () => {
    expect(() => assertRoomTransition('VACANT_CLEAN', 'OCCUPIED')).not.toThrow();
    expect(() => assertRoomTransition('OCCUPIED', 'VACANT_DIRTY')).not.toThrow();
  });
});

describe('manual transitions housekeeping may perform', () => {
  it('lets housekeeping clean a dirty room', () => {
    expect(() => assertManualRoomTransition('VACANT_DIRTY', 'VACANT_CLEAN')).not.toThrow();
  });

  it('lets maintenance take a vacant room out of order, and bring it back', () => {
    expect(() => assertManualRoomTransition('VACANT_CLEAN', 'OOO')).not.toThrow();
    expect(() => assertManualRoomTransition('OOO', 'VACANT_DIRTY')).not.toThrow();
  });

  it('lets a clean room be marked dirty (a guest walked through it)', () => {
    expect(() => assertManualRoomTransition('VACANT_CLEAN', 'VACANT_DIRTY')).not.toThrow();
  });

  it('rejects a nonsense jump', () => {
    expect(() => assertManualRoomTransition('OOO', 'OOS')).toThrow(IllegalRoomTransitionError);
  });

  it('offers only safe options for each vacant state', () => {
    expect(allowedManualRoomTransitions('VACANT_CLEAN')).toEqual(['VACANT_DIRTY', 'OOO', 'OOS']);
    expect(allowedManualRoomTransitions('VACANT_DIRTY')).toEqual(['VACANT_CLEAN', 'OOO', 'OOS']);
    expect(allowedManualRoomTransitions('OCCUPIED')).toEqual([]);
  });
});

/**
 * A dirty room is still sellable — housekeeping turns it over before arrival.
 * Treating dirty as unsellable would idle most of the hotel every morning.
 */
describe('sellability and blocking', () => {
  it('treats a dirty room as sellable', () => {
    expect(isSellable('VACANT_DIRTY')).toBe(true);
    expect(isBlocked('VACANT_DIRTY')).toBe(false);
  });

  it('treats clean and occupied as sellable (occupied is sold, not blocked)', () => {
    expect(isSellable('VACANT_CLEAN')).toBe(true);
    expect(isSellable('OCCUPIED')).toBe(true);
  });

  it('blocks OOO and OOS from inventory', () => {
    for (const s of ['OOO', 'OOS'] as const) {
      expect(isSellable(s)).toBe(false);
      expect(isBlocked(s)).toBe(true);
    }
  });

  it('isSellable and isBlocked are exact complements', () => {
    for (const s of ROOM_STATUSES) {
      expect(isSellable(s)).toBe(!isBlocked(s));
    }
  });

  it('identifies occupancy', () => {
    expect(isOccupied('OCCUPIED')).toBe(true);
    expect(isOccupied('VACANT_CLEAN')).toBe(false);
  });
});
