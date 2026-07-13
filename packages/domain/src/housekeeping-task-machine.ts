/**
 * Housekeeping task machine.
 *
 * The one rule that matters here is the loop back from DONE to PENDING.
 *
 * A room is not clean because an attendant said so — it is clean because a
 * supervisor looked. `DONE` is a claim; `INSPECTED` is a fact. When an inspection
 * FAILS, the task must reopen and the room must go back to dirty. A system that
 * treats a failed inspection as a terminal state, or that silently leaves the room
 * marked clean, hands the next guest a room somebody ticked off without cleaning.
 *
 * That single backward edge is most of the reason this module exists.
 */
import type { HousekeepingTaskStatus, RoomStatus } from './enums.js';

const TRANSITIONS: Readonly<Record<HousekeepingTaskStatus, readonly HousekeepingTaskStatus[]>> = {
  /**
   * PENDING → DONE is allowed on purpose. An attendant who cleans a room and only
   * then remembers the tablet is the normal case, not an error, and a machine that
   * forces them to press "start" on a finished room teaches them to lie about when
   * they started.
   */
  PENDING: ['IN_PROGRESS', 'DONE'],

  IN_PROGRESS: ['DONE', 'PENDING'], // PENDING = put it back down, someone else takes it

  /** INSPECTED = passed. PENDING = failed inspection; clean it again. */
  DONE: ['INSPECTED', 'PENDING'],

  /** Terminal. The day's work on this room is finished and signed off. */
  INSPECTED: [],
};

export class IllegalTaskTransitionError extends Error {
  constructor(
    readonly from: HousekeepingTaskStatus,
    readonly to: HousekeepingTaskStatus,
    reason?: string,
  ) {
    super(reason ?? `Illegal housekeeping task transition: ${from} → ${to}`);
    this.name = 'IllegalTaskTransitionError';
  }
}

export function canTransitionTask(
  from: HousekeepingTaskStatus,
  to: HousekeepingTaskStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(
  from: HousekeepingTaskStatus,
  to: HousekeepingTaskStatus,
): void {
  if (from === 'INSPECTED') {
    throw new IllegalTaskTransitionError(
      from,
      to,
      'This task was inspected and signed off. Raise a new task rather than reopening a closed one.',
    );
  }

  if (!canTransitionTask(from, to)) throw new IllegalTaskTransitionError(from, to);
}

export function allowedTaskTransitions(
  from: HousekeepingTaskStatus,
): readonly HousekeepingTaskStatus[] {
  return TRANSITIONS[from];
}

/**
 * What finishing this task does to the ROOM.
 *
 * A departure clean turns the room over: dirty → clean, ready to sell.
 *
 * A stayover clean must NOT. The guest is still in the room — it is OCCUPIED, and
 * it stays OCCUPIED. Marking it VACANT_CLEAN would put an occupied room back into
 * inventory and sell it out from under someone who is asleep in it. (The room-status
 * machine has no OCCUPIED → VACANT_CLEAN edge either, so this is belt and braces —
 * deliberately.)
 *
 * Returns the room status the task completion implies, or null for "leave it alone".
 */
export function roomStatusAfterTask(
  taskType: string,
  currentRoomStatus: RoomStatus,
): RoomStatus | null {
  if (currentRoomStatus === 'OCCUPIED') return null; // stayover / turndown: guest is in it
  if (currentRoomStatus === 'OOO' || currentRoomStatus === 'OOS') return null; // still off-market

  // DEPARTURE and DEEP_CLEAN both turn a vacant room over.
  if (currentRoomStatus === 'VACANT_DIRTY') return 'VACANT_CLEAN';

  return null; // already clean — nothing to do
}

/**
 * May this user work this task?
 *
 * An unassigned task is fair game — whoever picks it up owns it. A task already
 * assigned to Sunita is Sunita's: another attendant marking it done is either a
 * mistake or a way to make the board look finished when it is not. Supervisors
 * (checked at the resolver) are exempt; this is the attendant rule.
 */
export function canWorkTask(
  task: { assignedTo: string | null },
  userId: string,
): boolean {
  return task.assignedTo === null || task.assignedTo === userId;
}
