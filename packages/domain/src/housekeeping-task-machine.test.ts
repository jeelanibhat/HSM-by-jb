import { describe, expect, it } from 'vitest';
import {
  allowedTaskTransitions,
  assertTaskTransition,
  canTransitionTask,
  canWorkTask,
  IllegalTaskTransitionError,
  roomStatusAfterTask,
} from './housekeeping-task-machine.js';
import { HOUSEKEEPING_TASK_STATUSES, type HousekeepingTaskStatus } from './enums.js';

describe('housekeeping task machine', () => {
  describe('the working path', () => {
    it('walks pick up → clean → sign off', () => {
      expect(canTransitionTask('PENDING', 'IN_PROGRESS')).toBe(true);
      expect(canTransitionTask('IN_PROGRESS', 'DONE')).toBe(true);
      expect(canTransitionTask('DONE', 'INSPECTED')).toBe(true);
    });

    it('lets an attendant mark a room done without pressing start first', () => {
      // Cleaning the room and only then remembering the tablet is the normal case.
      // A machine that forbids it just teaches people to lie about start times.
      expect(canTransitionTask('PENDING', 'DONE')).toBe(true);
    });

    it('lets an attendant put a task back down', () => {
      expect(canTransitionTask('IN_PROGRESS', 'PENDING')).toBe(true);
    });
  });

  describe('a failed inspection', () => {
    it('reopens the task', () => {
      // THE rule. DONE is a claim; INSPECTED is a fact. If the supervisor finds the
      // room dirty, the work is not finished — it is pending again.
      expect(canTransitionTask('DONE', 'PENDING')).toBe(true);
      expect(() => assertTaskTransition('DONE', 'PENDING')).not.toThrow();
    });
  });

  describe('INSPECTED is terminal', () => {
    it.each(HOUSEKEEPING_TASK_STATUSES)('refuses INSPECTED → %s', (to) => {
      expect(() => assertTaskTransition('INSPECTED', to)).toThrow(IllegalTaskTransitionError);
    });

    it('explains itself rather than saying "illegal transition"', () => {
      expect(() => assertTaskTransition('INSPECTED', 'PENDING')).toThrow(/signed off/i);
    });

    it('offers nothing to do next', () => {
      expect(allowedTaskTransitions('INSPECTED')).toEqual([]);
    });
  });

  describe('every illegal transition is refused', () => {
    const LEGAL = new Set([
      'PENDING→IN_PROGRESS',
      'PENDING→DONE',
      'IN_PROGRESS→DONE',
      'IN_PROGRESS→PENDING',
      'DONE→INSPECTED',
      'DONE→PENDING',
    ]);

    const pairs = HOUSEKEEPING_TASK_STATUSES.flatMap((from) =>
      HOUSEKEEPING_TASK_STATUSES.map((to) => [from, to] as [HousekeepingTaskStatus, HousekeepingTaskStatus]),
    );

    it.each(pairs)('%s → %s', (from, to) => {
      const legal = LEGAL.has(`${from}→${to}`);
      expect(canTransitionTask(from, to)).toBe(legal);

      if (legal) {
        expect(() => assertTaskTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertTaskTransition(from, to)).toThrow(IllegalTaskTransitionError);
      }
    });

    it('never lets a task skip straight from PENDING to INSPECTED', () => {
      // Signing off work nobody has claimed to have done.
      expect(canTransitionTask('PENDING', 'INSPECTED')).toBe(false);
    });

    it('never lets IN_PROGRESS be inspected', () => {
      expect(canTransitionTask('IN_PROGRESS', 'INSPECTED')).toBe(false);
    });
  });

  describe('what finishing a task does to the room', () => {
    it('turns a departed room over: dirty → clean', () => {
      expect(roomStatusAfterTask('DEPARTURE', 'VACANT_DIRTY')).toBe('VACANT_CLEAN');
    });

    it('deep-cleans a vacant dirty room to clean', () => {
      expect(roomStatusAfterTask('DEEP_CLEAN', 'VACANT_DIRTY')).toBe('VACANT_CLEAN');
    });

    it('NEVER frees an occupied room', () => {
      // The guest is asleep in it. Marking the room VACANT_CLEAN would put it back in
      // inventory and sell it out from under them.
      expect(roomStatusAfterTask('STAYOVER', 'OCCUPIED')).toBeNull();
      expect(roomStatusAfterTask('TURNDOWN', 'OCCUPIED')).toBeNull();
      expect(roomStatusAfterTask('DEPARTURE', 'OCCUPIED')).toBeNull();
    });

    it('does not quietly return an out-of-order room to the market', () => {
      // The room is broken. Someone cleaning it does not make the plumbing work.
      expect(roomStatusAfterTask('DEEP_CLEAN', 'OOO')).toBeNull();
      expect(roomStatusAfterTask('DEEP_CLEAN', 'OOS')).toBeNull();
    });

    it('leaves an already-clean room alone', () => {
      expect(roomStatusAfterTask('DEPARTURE', 'VACANT_CLEAN')).toBeNull();
    });
  });

  describe('who may work a task', () => {
    it('lets anyone pick up an unassigned task', () => {
      expect(canWorkTask({ assignedTo: null }, 'sunita')).toBe(true);
    });

    it('lets the assignee work their own task', () => {
      expect(canWorkTask({ assignedTo: 'sunita' }, 'sunita')).toBe(true);
    });

    it("refuses to let one attendant close another's task", () => {
      // Otherwise the board can be made to look finished by someone who cleaned nothing.
      expect(canWorkTask({ assignedTo: 'sunita' }, 'ravi')).toBe(false);
    });
  });
});
