import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  assertTaskTransition,
  canWorkTask,
  IllegalTaskTransitionError,
  roomStatusAfterTask,
  type HousekeepingTaskStatus,
  type HousekeepingTaskType,
  type RoomStatus,
} from '@hotelos/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { TransactionalUnitOfWork, type ActorContext, type UnitOfWork } from '../../../shared';
import { users } from '../../identity/infra/schema';
import { rooms, roomTypes } from '../../inventory/infra/schema';
import { properties } from '../../property/infra/schema';
import { reservationRooms, reservations } from '../../reservations/infra/schema';
import { housekeepingTasks } from '../infra/schema';

/**
 * Roughly how many minutes each kind of task takes.
 *
 * A supervisor splitting the morning between five attendants is splitting WORK, not
 * room count: eight departures is not the same day as eight turndowns. Credits make
 * the board's workload column mean something.
 */
const CREDITS: Readonly<Record<HousekeepingTaskType, number>> = {
  DEPARTURE: 45,
  STAYOVER: 20,
  DEEP_CLEAN: 90,
  TURNDOWN: 10,
};

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === UNIQUE_VIOLATION;
}

@Injectable()
export class HousekeepingService {
  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly tx: TenantTransaction,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * The day's board. Joined to the room so the attendant sees "204 · Deluxe", not a
   * UUID, and to the assignee so the supervisor sees who has what.
   */
  async board(propertyId: string, date?: string) {
    return this.tx.run(propertyId, async (tx) => {
      const businessDate = date ?? (await this.readBusinessDate(tx, propertyId));

      return tx
        .select({
          id: housekeepingTasks.id,
          roomId: housekeepingTasks.roomId,
          roomNumber: rooms.number,
          roomFloor: rooms.floor,
          roomStatus: rooms.status,
          roomTypeCode: roomTypes.code,
          businessDate: housekeepingTasks.businessDate,
          type: housekeepingTasks.type,
          status: housekeepingTasks.status,
          assignedTo: housekeepingTasks.assignedTo,
          assigneeName: users.name,
          credits: housekeepingTasks.credits,
          notes: housekeepingTasks.notes,
          inspectionNote: housekeepingTasks.inspectionNote,
          failedInspections: housekeepingTasks.failedInspections,
          startedAt: housekeepingTasks.startedAt,
          completedAt: housekeepingTasks.completedAt,
          inspectedAt: housekeepingTasks.inspectedAt,
        })
        .from(housekeepingTasks)
        .innerJoin(rooms, eq(rooms.id, housekeepingTasks.roomId))
        .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
        .leftJoin(users, eq(users.id, housekeepingTasks.assignedTo))
        .where(eq(housekeepingTasks.businessDate, businessDate))
        .orderBy(asc(rooms.floor), asc(rooms.number));
    });
  }

  /** The staff who can actually be given a task. */
  async attendants(propertyId: string) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .selectDistinct({ id: users.id, name: users.name })
        .from(users)
        .orderBy(asc(users.name)),
    );
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /**
   * Build the day's board from what the hotel is actually doing today.
   *
   *   - a room whose guest has already left is VACANT_DIRTY  → DEPARTURE clean
   *   - a room whose guest leaves today                      → DEPARTURE clean
   *   - a room whose guest is staying on                     → STAYOVER service
   *
   * IDEMPOTENT, and that is the whole design of it. A supervisor will hit this
   * button twice; two supervisors will hit it at once; one day the night audit will
   * call it too. `ON CONFLICT DO NOTHING` against the (room, date, type) unique
   * constraint means the second run creates nothing — it does not double the
   * morning's work, and it does not wipe the progress of a task already underway.
   */
  async generateBoard(actor: ActorContext, date?: string) {
    return this.uow.execute(actor, async (u) => {
      const businessDate = date ?? (await this.readBusinessDate(u.tx, actor.propertyId));

      // Rooms with a guest in them right now, and whether that guest leaves today.
      const inHouse = await u.tx
        .select({
          roomId: reservationRooms.roomId,
          departureDate: reservations.departureDate,
        })
        .from(reservationRooms)
        .innerJoin(reservations, eq(reservations.id, reservationRooms.reservationId))
        .where(
          and(
            eq(reservations.status, 'CHECKED_IN'),
            sql`${reservationRooms.roomId} IS NOT NULL`,
          ),
        );

      const wanted = new Map<string, HousekeepingTaskType>();

      for (const r of inHouse) {
        if (!r.roomId) continue;
        wanted.set(r.roomId, r.departureDate === businessDate ? 'DEPARTURE' : 'STAYOVER');
      }

      // Rooms the guest has already vacated. These are the urgent ones — somebody is
      // arriving into them this afternoon.
      const dirty = await u.tx
        .select({ id: rooms.id })
        .from(rooms)
        .where(eq(rooms.status, 'VACANT_DIRTY'));

      for (const room of dirty) wanted.set(room.id, 'DEPARTURE');

      if (wanted.size === 0) return { created: 0, businessDate };

      const created = await u.tx
        .insert(housekeepingTasks)
        .values(
          [...wanted].map(([roomId, type]) => ({
            id: uuidv7(),
            propertyId: actor.propertyId,
            roomId,
            businessDate,
            type,
            status: 'PENDING' as const,
            credits: CREDITS[type],
          })),
        )
        // The unique constraint does the idempotency. Re-running is a no-op, not a
        // double-up and not a reset.
        .onConflictDoNothing({
          target: [
            housekeepingTasks.roomId,
            housekeepingTasks.businessDate,
            housekeepingTasks.type,
          ],
        })
        .returning({ id: housekeepingTasks.id });

      u.audit({
        action: 'housekeeping.board_generated',
        entityType: 'property',
        entityId: actor.propertyId,
        after: { businessDate, created: created.length, considered: wanted.size },
      });

      return { created: created.length, businessDate };
    });
  }

  /** Raise a one-off task — a deep clean after a repair, a turndown for a VIP. */
  async createTask(
    actor: ActorContext,
    input: { roomId: string; type: HousekeepingTaskType; businessDate?: string; notes?: string },
  ) {
    return this.uow.execute(actor, async (u) => {
      const businessDate =
        input.businessDate ?? (await this.readBusinessDate(u.tx, actor.propertyId));

      const [room] = await u.tx.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1);
      if (!room) throw new NotFoundException('Room not found');

      const id = uuidv7();

      try {
        const [task] = await u.tx
          .insert(housekeepingTasks)
          .values({
            id,
            propertyId: actor.propertyId,
            roomId: input.roomId,
            businessDate,
            type: input.type,
            status: 'PENDING',
            credits: CREDITS[input.type],
            notes: input.notes ?? null,
          })
          .returning();

        u.audit({
          action: 'housekeeping.task_created',
          entityType: 'housekeeping_task',
          entityId: id,
          after: task,
        });

        return task!;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            `Room ${room.number} already has a ${input.type} task for ${businessDate}.`,
          );
        }
        throw err;
      }
    });
  }

  /** Give a task to an attendant, or put it back on the board (assignedTo: null). */
  async assign(actor: ActorContext, input: { taskId: string; assignedTo: string | null }) {
    return this.uow.execute(actor, async (u) => {
      const task = await this.lockTask(u, input.taskId);

      if (task.status === 'INSPECTED') {
        throw new BadRequestException('That task is finished and signed off.');
      }

      if (input.assignedTo !== null) {
        const [user] = await u.tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, input.assignedTo))
          .limit(1);

        if (!user) throw new NotFoundException('User not found');
      }

      const [updated] = await u.tx
        .update(housekeepingTasks)
        .set({ assignedTo: input.assignedTo, updatedAt: new Date() })
        .where(eq(housekeepingTasks.id, input.taskId))
        .returning();

      u.audit({
        action: 'housekeeping.task_assigned',
        entityType: 'housekeeping_task',
        entityId: input.taskId,
        before: { assignedTo: task.assignedTo },
        after: { assignedTo: input.assignedTo },
      });

      u.emit({
        aggregateType: 'housekeeping_task',
        aggregateId: input.taskId,
        eventType: 'housekeeping.task_assigned',
        payload: { taskId: input.taskId, roomId: task.roomId, assignedTo: input.assignedTo },
      });

      return updated!;
    });
  }

  /**
   * Pick a task up. An unassigned task becomes yours by starting it — an attendant
   * should not have to wait for a supervisor to type their name in.
   */
  async start(actor: ActorContext, taskId: string, isSupervisor: boolean) {
    return this.uow.execute(actor, async (u) => {
      const task = await this.lockTask(u, taskId);

      this.assertMayWork(task, actor.userId, isSupervisor);
      this.transition(task.status as HousekeepingTaskStatus, 'IN_PROGRESS');

      const [updated] = await u.tx
        .update(housekeepingTasks)
        .set({
          status: 'IN_PROGRESS',
          // Picking it up claims it.
          assignedTo: task.assignedTo ?? actor.userId,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(housekeepingTasks.id, taskId))
        .returning();

      u.audit({
        action: 'housekeeping.task_started',
        entityType: 'housekeeping_task',
        entityId: taskId,
        before: { status: task.status },
        after: { status: 'IN_PROGRESS', assignedTo: task.assignedTo ?? actor.userId },
      });

      return updated!;
    });
  }

  /**
   * The room is cleaned.
   *
   * A DEPARTURE clean turns the room over — VACANT_DIRTY → VACANT_CLEAN, in the SAME
   * transaction, so the room and the task can never disagree.
   *
   * A STAYOVER clean does not touch the room's status: the guest is still in it.
   * roomStatusAfterTask decides, and it returns null for an OCCUPIED room.
   */
  async complete(actor: ActorContext, taskId: string, isSupervisor: boolean, notes?: string) {
    return this.uow.execute(actor, async (u) => {
      const task = await this.lockTask(u, taskId);

      this.assertMayWork(task, actor.userId, isSupervisor);
      this.transition(task.status as HousekeepingTaskStatus, 'DONE');

      const [room] = await u.tx
        .select()
        .from(rooms)
        .where(eq(rooms.id, task.roomId))
        .limit(1)
        .for('update');

      if (!room) throw new NotFoundException('Room not found');

      const [updated] = await u.tx
        .update(housekeepingTasks)
        .set({
          status: 'DONE',
          assignedTo: task.assignedTo ?? actor.userId,
          completedAt: new Date(),
          ...(notes !== undefined ? { notes } : {}),
          updatedAt: new Date(),
        })
        .where(eq(housekeepingTasks.id, taskId))
        .returning();

      const nextRoomStatus = roomStatusAfterTask(task.type, room.status as RoomStatus);

      if (nextRoomStatus) {
        await this.setRoomStatus(u, room.id, room.status as RoomStatus, nextRoomStatus, room.number);
      }

      u.audit({
        action: 'housekeeping.task_completed',
        entityType: 'housekeeping_task',
        entityId: taskId,
        before: { status: task.status },
        after: { status: 'DONE', roomStatus: nextRoomStatus ?? room.status },
      });

      u.emit({
        aggregateType: 'housekeeping_task',
        aggregateId: taskId,
        eventType: 'housekeeping.task_completed',
        payload: { taskId, roomId: room.id, roomNumber: room.number, type: task.type },
      });

      return updated!;
    });
  }

  /**
   * A supervisor looked.
   *
   * PASS  → the task is signed off. Terminal.
   * FAIL  → the task reopens (PENDING) and the room goes back to VACANT_DIRTY.
   *
   * The failure path is the entire point of inspection. If a failed inspection left
   * the room marked clean, the next guest would be handed a room that a supervisor
   * had personally judged unfit — and the system would have recorded the judgement
   * and then ignored it.
   */
  async inspect(actor: ActorContext, taskId: string, passed: boolean, reason?: string) {
    return this.uow.execute(actor, async (u) => {
      const task = await this.lockTask(u, taskId);

      const [room] = await u.tx
        .select()
        .from(rooms)
        .where(eq(rooms.id, task.roomId))
        .limit(1)
        .for('update');

      if (!room) throw new NotFoundException('Room not found');

      if (passed) {
        this.transition(task.status as HousekeepingTaskStatus, 'INSPECTED');

        const [updated] = await u.tx
          .update(housekeepingTasks)
          .set({
            status: 'INSPECTED',
            inspectedBy: actor.userId,
            inspectedAt: new Date(),
            inspectionNote: null,
            updatedAt: new Date(),
          })
          .where(eq(housekeepingTasks.id, taskId))
          .returning();

        u.audit({
          action: 'housekeeping.task_inspected',
          entityType: 'housekeeping_task',
          entityId: taskId,
          before: { status: task.status },
          after: { status: 'INSPECTED', passed: true },
        });

        u.emit({
          aggregateType: 'housekeeping_task',
          aggregateId: taskId,
          eventType: 'housekeeping.task_inspected',
          payload: { taskId, roomId: room.id, roomNumber: room.number, passed: true },
        });

        return updated!;
      }

      // ── Failed ────────────────────────────────────────────────────────────────
      this.transition(task.status as HousekeepingTaskStatus, 'PENDING');

      const [updated] = await u.tx
        .update(housekeepingTasks)
        .set({
          status: 'PENDING',
          inspectedBy: actor.userId,
          inspectedAt: new Date(),
          inspectionNote: reason ?? 'Failed inspection',
          failedInspections: task.failedInspections + 1,
          // Reopened: it is not done, and it has not been started again yet.
          completedAt: null,
          startedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(housekeepingTasks.id, taskId))
        .returning();

      // The room is NOT clean. Say so, or it will be sold.
      if (room.status === 'VACANT_CLEAN') {
        await this.setRoomStatus(u, room.id, 'VACANT_CLEAN', 'VACANT_DIRTY', room.number);
      }

      u.audit({
        action: 'housekeeping.task_inspection_failed',
        entityType: 'housekeeping_task',
        entityId: taskId,
        before: { status: task.status, roomStatus: room.status },
        after: { status: 'PENDING', roomStatus: 'VACANT_DIRTY' },
        reason,
      });

      u.emit({
        aggregateType: 'housekeeping_task',
        aggregateId: taskId,
        eventType: 'housekeeping.inspection_failed',
        payload: { taskId, roomId: room.id, roomNumber: room.number, reason: reason ?? null },
      });

      return updated!;
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * Lock the task row. Two attendants tapping "done" on the same room at the same
   * moment would otherwise both read PENDING and both pass the transition check.
   */
  private async lockTask(u: UnitOfWork, taskId: string) {
    const [task] = await u.tx
      .select()
      .from(housekeepingTasks)
      .where(eq(housekeepingTasks.id, taskId))
      .limit(1)
      .for('update');

    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  private transition(from: HousekeepingTaskStatus, to: HousekeepingTaskStatus): void {
    try {
      assertTaskTransition(from, to);
    } catch (err) {
      if (err instanceof IllegalTaskTransitionError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /**
   * An attendant works their own sheet. A supervisor may work anyone's — they are the
   * ones covering a sick call at 11am.
   */
  private assertMayWork(
    task: { assignedTo: string | null },
    userId: string,
    isSupervisor: boolean,
  ): void {
    if (isSupervisor) return;

    if (!canWorkTask(task, userId)) {
      throw new ForbiddenException(
        'That room is assigned to someone else. Ask a supervisor to reassign it.',
      );
    }
  }

  /**
   * Change the room's status from inside a housekeeping transaction.
   *
   * This deliberately does NOT call InventoryService: that would open a second
   * transaction, and a crash between the two would leave a task marked DONE and a
   * room still dirty. Same unit of work, same commit, same audit trail.
   */
  private async setRoomStatus(
    u: UnitOfWork,
    roomId: string,
    from: RoomStatus,
    to: RoomStatus,
    number: string,
  ): Promise<void> {
    await u.tx
      .update(rooms)
      .set({ status: to, updatedAt: new Date() })
      .where(eq(rooms.id, roomId));

    u.audit({
      action: 'room.status_changed',
      entityType: 'room',
      entityId: roomId,
      before: { status: from },
      after: { status: to },
    });

    u.emit({
      aggregateType: 'room',
      aggregateId: roomId,
      eventType: 'room.status_changed',
      payload: { roomId, number, from, to },
    });
  }

  private async readBusinessDate(
    tx: { select: UnitOfWork['tx']['select'] },
    propertyId: string,
  ): Promise<string> {
    const [property] = await tx
      .select({ businessDate: properties.businessDate })
      .from(properties)
      .where(eq(properties.id, propertyId))
      .limit(1);

    if (!property) throw new NotFoundException('Property not found');
    return property.businessDate;
  }
}
