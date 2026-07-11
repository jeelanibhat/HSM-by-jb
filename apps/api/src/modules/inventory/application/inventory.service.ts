import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  assertManualRoomTransition,
  assertRoomTransition,
  eachDateInclusive,
  businessDate,
  IllegalRoomTransitionError,
  type RoomStatus,
} from '@hotelos/domain';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { TransactionalUnitOfWork, type ActorContext } from '../../../shared';
import { ratePlans, ratePrices, rooms, roomTypes } from '../infra/schema';

/** Postgres unique-violation. Turning it into a 409-ish domain error, not a 500. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === UNIQUE_VIOLATION;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly tx: TenantTransaction,
  ) {}

  // ── Reads (RLS scopes them; no WHERE property_id needed, and none would help) ──

  async listRoomTypes(propertyId: string) {
    return this.tx.run(propertyId, (tx) =>
      tx.select().from(roomTypes).orderBy(asc(roomTypes.code)),
    );
  }

  async listRooms(propertyId: string) {
    return this.tx.run(propertyId, (tx) => tx.select().from(rooms).orderBy(asc(rooms.number)));
  }

  async listRatePlans(propertyId: string) {
    return this.tx.run(propertyId, (tx) =>
      tx.select().from(ratePlans).orderBy(asc(ratePlans.code)),
    );
  }

  async listRatePrices(propertyId: string, roomTypeId: string, from: string, to: string) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select()
        .from(ratePrices)
        .where(
          and(
            eq(ratePrices.roomTypeId, roomTypeId),
            gte(ratePrices.date, from),
            lte(ratePrices.date, to),
          ),
        )
        .orderBy(asc(ratePrices.date)),
    );
  }

  // ── Writes (every one goes through the unit of work → audited + evented) ──

  async createRoomType(
    actor: ActorContext,
    input: {
      code: string;
      name: string;
      baseOccupancy: number;
      maxOccupancy: number;
      description?: string;
    },
  ) {
    return this.uow.execute(actor, async (u) => {
      const id = uuidv7();

      try {
        const [created] = await u.tx
          .insert(roomTypes)
          .values({
            id,
            propertyId: actor.propertyId,
            code: input.code,
            name: input.name,
            baseOccupancy: input.baseOccupancy,
            maxOccupancy: input.maxOccupancy,
            description: input.description ?? null,
          })
          .returning();

        u.audit({
          action: 'room_type.created',
          entityType: 'room_type',
          entityId: id,
          after: created,
        });

        return created!;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(`Room type code '${input.code}' already exists.`);
        }
        throw err;
      }
    });
  }

  async createRoom(
    actor: ActorContext,
    input: { roomTypeId: string; number: string; floor?: string },
  ) {
    return this.uow.execute(actor, async (u) => {
      // The room type must belong to THIS property. RLS already guarantees a type
      // from another hotel is invisible here, so a missing row means either "does
      // not exist" or "not yours" — and we deliberately do not distinguish.
      const [type] = await u.tx
        .select()
        .from(roomTypes)
        .where(eq(roomTypes.id, input.roomTypeId))
        .limit(1);

      if (!type) throw new NotFoundException('Room type not found');

      const id = uuidv7();

      try {
        const [created] = await u.tx
          .insert(rooms)
          .values({
            id,
            propertyId: actor.propertyId,
            roomTypeId: input.roomTypeId,
            number: input.number,
            floor: input.floor ?? null,
            status: 'VACANT_CLEAN',
          })
          .returning();

        u.audit({ action: 'room.created', entityType: 'room', entityId: id, after: created });

        return created!;
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Two rooms numbered 101 is how a guest ends up at the wrong door.
          throw new BadRequestException(`Room ${input.number} already exists at this property.`);
        }
        throw err;
      }
    });
  }

  async createRatePlan(
    actor: ActorContext,
    input: {
      code: string;
      name: string;
      currency: string;
      mealPlan: string;
      description?: string;
    },
  ) {
    return this.uow.execute(actor, async (u) => {
      const id = uuidv7();

      try {
        const [created] = await u.tx
          .insert(ratePlans)
          .values({
            id,
            propertyId: actor.propertyId,
            code: input.code,
            name: input.name,
            currency: input.currency,
            mealPlan: input.mealPlan,
            description: input.description ?? null,
          })
          .returning();

        u.audit({
          action: 'rate_plan.created',
          entityType: 'rate_plan',
          entityId: id,
          after: created,
        });

        return created!;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(`Rate plan code '${input.code}' already exists.`);
        }
        throw err;
      }
    });
  }

  /**
   * Price a room type on a rate plan across a date range (inclusive).
   *
   * Upsert, not insert: re-pricing an already-priced date is the normal case —
   * revenue managers change rates constantly. An insert-only version would fail
   * the moment anyone adjusted a price, and a delete-then-insert would leave the
   * grid briefly empty, which the quote path could read.
   */
  async setRatePrices(
    actor: ActorContext,
    input: {
      ratePlanId: string;
      roomTypeId: string;
      from: string;
      to: string;
      priceMinor: number;
    },
  ) {
    const dates = eachDateInclusive(businessDate(input.from), businessDate(input.to));

    // A year at a time is normal; a decade is a mistake or an attack.
    if (dates.length > 730) {
      throw new BadRequestException('Cannot price more than 730 days in one call.');
    }

    return this.uow.execute(actor, async (u) => {
      const [plan] = await u.tx
        .select()
        .from(ratePlans)
        .where(eq(ratePlans.id, input.ratePlanId))
        .limit(1);
      if (!plan) throw new NotFoundException('Rate plan not found');

      const [type] = await u.tx
        .select()
        .from(roomTypes)
        .where(eq(roomTypes.id, input.roomTypeId))
        .limit(1);
      if (!type) throw new NotFoundException('Room type not found');

      await u.tx
        .insert(ratePrices)
        .values(
          dates.map((d) => ({
            id: uuidv7(),
            propertyId: actor.propertyId,
            ratePlanId: input.ratePlanId,
            roomTypeId: input.roomTypeId,
            date: d,
            priceMinor: input.priceMinor,
          })),
        )
        .onConflictDoUpdate({
          target: [ratePrices.ratePlanId, ratePrices.roomTypeId, ratePrices.date],
          set: { priceMinor: input.priceMinor, updatedAt: new Date() },
        });

      u.audit({
        action: 'rate_prices.set',
        entityType: 'rate_plan',
        entityId: input.ratePlanId,
        after: {
          roomTypeId: input.roomTypeId,
          from: input.from,
          to: input.to,
          priceMinor: input.priceMinor,
          nights: dates.length,
        },
      });

      return dates.length;
    });
  }

  /**
   * Manual room-status change — housekeeping, maintenance, front desk.
   *
   * Goes through assertManualRoomTransition, which refuses to take an OCCUPIED
   * room out of order (there is a guest in it) and refuses to let anyone declare
   * a room OCCUPIED by hand (that is check-in's job). See the room status machine.
   */
  async updateRoomStatus(
    actor: ActorContext,
    input: { roomId: string; status: RoomStatus; reason?: string },
  ) {
    return this.uow.execute(actor, async (u) => {
      // Lock the row: two housekeepers hitting "clean" on the same room at once
      // would otherwise both read VACANT_DIRTY and both pass the transition check.
      const [room] = await u.tx
        .select()
        .from(rooms)
        .where(eq(rooms.id, input.roomId))
        .limit(1)
        .for('update');

      if (!room) throw new NotFoundException('Room not found');

      const from = room.status as RoomStatus;

      if (from === input.status) return room; // idempotent no-op

      try {
        assertManualRoomTransition(from, input.status);
      } catch (err) {
        if (err instanceof IllegalRoomTransitionError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }

      const [updated] = await u.tx
        .update(rooms)
        .set({
          status: input.status,
          statusNote: input.reason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(rooms.id, input.roomId))
        .returning();

      u.audit({
        action: 'room.status_changed',
        entityType: 'room',
        entityId: input.roomId,
        before: { status: from },
        after: { status: input.status },
        reason: input.reason,
      });

      // Housekeeping boards and the tape chart both react to this (TDD §6).
      u.emit({
        aggregateType: 'room',
        aggregateId: input.roomId,
        eventType: 'room.status_changed',
        payload: { roomId: input.roomId, number: room.number, from, to: input.status },
      });

      return updated!;
    });
  }

  /**
   * System-driven status change, for the reservations module at check-in/out.
   * Uses the full transition table, not the manual subset.
   */
  async applySystemRoomStatus(
    actor: ActorContext,
    tx: Parameters<Parameters<TransactionalUnitOfWork['execute']>[1]>[0],
    roomId: string,
    to: RoomStatus,
  ) {
    const [room] = await tx.tx.select().from(rooms).where(eq(rooms.id, roomId)).limit(1).for('update');
    if (!room) throw new NotFoundException('Room not found');

    assertRoomTransition(room.status as RoomStatus, to);

    await tx.tx.update(rooms).set({ status: to, updatedAt: new Date() }).where(eq(rooms.id, roomId));

    tx.audit({
      action: 'room.status_changed',
      entityType: 'room',
      entityId: roomId,
      before: { status: room.status },
      after: { status: to },
    });

    tx.emit({
      aggregateType: 'room',
      aggregateId: roomId,
      eventType: 'room.status_changed',
      payload: { roomId, number: room.number, from: room.status, to },
    });
  }
}
