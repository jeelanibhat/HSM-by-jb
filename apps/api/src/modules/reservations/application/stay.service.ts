import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  assertRoomTransition,
  assertTransition,
  IllegalRoomTransitionError,
  IllegalTransitionError,
  type ReservationStatus,
  type RoomStatus,
} from '@hotelos/domain';
import { eq } from 'drizzle-orm';
import { TransactionalUnitOfWork, type ActorContext, type UnitOfWork } from '../../../shared';
import { FolioService } from '../../folio';
import { rooms } from '../../inventory/infra/schema';
import { properties } from '../../property/infra/schema';
import { reservationRooms, reservations } from '../infra/schema';

/**
 * Check-in and check-out (TDD step 8).
 *
 * These are the two moments where a reservation stops being a row and becomes a
 * person in a building. Each one moves THREE things that must agree — the
 * reservation's state, the room's state, and the folio — and all three move inside
 * one transaction. A check-in that marked the room occupied but failed to open a
 * folio would leave a guest in a room with nowhere to post their bar tab.
 */
@Injectable()
export class StayService {
  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly folio: FolioService,
  ) {}

  /**
   * Check in.
   *
   *   reservation  CONFIRMED     → CHECKED_IN
   *   room         VACANT_*      → OCCUPIED
   *   folio        (none)        → OPEN
   *
   * A room MUST be assigned first. Selling a room type is not the same as putting
   * someone in a room, and the exclusion constraint only protects an assigned room.
   */
  async checkIn(actor: ActorContext, reservationId: string) {
    return this.uow.execute(actor, async (u) => {
      const reservation = await this.loadForUpdate(u, reservationId);

      try {
        // ENQUIRY → CHECKED_IN is illegal; so is checking in a cancelled booking or
        // one that already checked in.
        assertTransition(reservation.status as ReservationStatus, 'CHECKED_IN');
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          throw new BadRequestException(
            `Cannot check in a ${reservation.status.toLowerCase().replace('_', ' ')} reservation.`,
          );
        }
        throw err;
      }

      const lines = await u.tx
        .select()
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, reservationId));

      const unassigned = lines.filter((l) => !l.roomId);
      if (unassigned.length > 0) {
        throw new BadRequestException(
          `Assign a room before checking in (${unassigned.length} of ${lines.length} rooms still unassigned).`,
        );
      }

      const [property] = await u.tx
        .select()
        .from(properties)
        .where(eq(properties.id, actor.propertyId))
        .limit(1);
      if (!property) throw new NotFoundException('Property not found');

      // Move every room to OCCUPIED.
      for (const line of lines) {
        await this.moveRoom(u, line.roomId!, 'OCCUPIED');
      }

      const now = new Date();

      await u.tx
        .update(reservationRooms)
        .set({ status: 'CHECKED_IN', checkedInAt: now, updatedAt: now })
        .where(eq(reservationRooms.reservationId, reservationId));

      const [updated] = await u.tx
        .update(reservations)
        .set({ status: 'CHECKED_IN', updatedAt: now })
        .where(eq(reservations.id, reservationId))
        .returning();

      // The bill opens in the SAME transaction. A guest in a room without a folio is
      // a guest whose charges have nowhere to go.
      const folio = await this.folio.openForReservation(
        u,
        reservationId,
        reservation.guestId,
        property.currency,
      );

      u.audit({
        action: 'reservation.checked_in',
        entityType: 'reservation',
        entityId: reservationId,
        before: { status: reservation.status },
        after: { status: 'CHECKED_IN', folioId: folio.id },
      });

      u.emit({
        aggregateType: 'reservation',
        aggregateId: reservationId,
        eventType: 'reservation.checked_in',
        payload: {
          confirmationNo: reservation.confirmationNo,
          folioId: folio.id,
          rooms: lines.map((l) => l.roomId),
        },
      });

      return { reservation: updated!, folioId: folio.id };
    });
  }

  /**
   * Check out.
   *
   *   folio        balance MUST be zero  (TDD §6)
   *   reservation  CHECKED_IN → CHECKED_OUT
   *   room         OCCUPIED   → VACANT_DIRTY
   *   folio        OPEN       → SETTLED
   *
   * The balance check comes FIRST and it is not negotiable. A guest who walks out
   * with an open balance and a closed bill is money the hotel will never collect —
   * and the room reports itself as settled, so nobody ever notices.
   */
  async checkOut(actor: ActorContext, reservationId: string) {
    return this.uow.execute(actor, async (u) => {
      const reservation = await this.loadForUpdate(u, reservationId);

      try {
        assertTransition(reservation.status as ReservationStatus, 'CHECKED_OUT');
      } catch (err) {
        if (err instanceof IllegalTransitionError) {
          throw new BadRequestException(
            `Cannot check out a ${reservation.status.toLowerCase().replace('_', ' ')} reservation.`,
          );
        }
        throw err;
      }

      const [property] = await u.tx
        .select()
        .from(properties)
        .where(eq(properties.id, actor.propertyId))
        .limit(1);
      if (!property) throw new NotFoundException('Property not found');

      const folio = await this.folioFor(u, reservationId);

      // THE rule. Throws with the amount owed, so the clerk can say it out loud.
      await this.folio.assertSettled(u, folio.id, property.currency);

      const lines = await u.tx
        .select()
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, reservationId));

      for (const line of lines) {
        if (!line.roomId) continue;
        // Not VACANT_CLEAN — nobody has cleaned it yet. Housekeeping turns it over,
        // and the room board shows it as dirty until they do.
        await this.moveRoom(u, line.roomId, 'VACANT_DIRTY');
      }

      const now = new Date();

      await u.tx
        .update(reservationRooms)
        .set({ status: 'CHECKED_OUT', checkedOutAt: now, updatedAt: now })
        .where(eq(reservationRooms.reservationId, reservationId));

      const [updated] = await u.tx
        .update(reservations)
        .set({ status: 'CHECKED_OUT', updatedAt: now })
        .where(eq(reservations.id, reservationId))
        .returning();

      await this.folio.close(u, folio.id);

      u.audit({
        action: 'reservation.checked_out',
        entityType: 'reservation',
        entityId: reservationId,
        before: { status: reservation.status },
        after: { status: 'CHECKED_OUT', folioId: folio.id },
      });

      u.emit({
        aggregateType: 'reservation',
        aggregateId: reservationId,
        eventType: 'reservation.checked_out',
        payload: { confirmationNo: reservation.confirmationNo, folioId: folio.id },
      });

      return { reservation: updated!, folioId: folio.id };
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * System-driven room status change. Uses the FULL transition table — unlike the
   * manual path, check-in is exactly the thing allowed to make a room OCCUPIED.
   */
  private async moveRoom(u: UnitOfWork, roomId: string, to: RoomStatus): Promise<void> {
    const [room] = await u.tx
      .select()
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1)
      .for('update');

    if (!room) throw new NotFoundException('Room not found');

    const from = room.status as RoomStatus;
    if (from === to) return;

    try {
      assertRoomTransition(from, to);
    } catch (err) {
      if (err instanceof IllegalRoomTransitionError) {
        // e.g. checking in to a room someone left OOO.
        throw new BadRequestException(`Room ${room.number}: ${err.message}`);
      }
      throw err;
    }

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
      payload: { roomId, number: room.number, from, to },
    });
  }

  private async loadForUpdate(u: UnitOfWork, id: string) {
    const [reservation] = await u.tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, id))
      .limit(1)
      .for('update');

    if (!reservation) throw new NotFoundException('Reservation not found');
    return reservation;
  }

  private async folioFor(u: UnitOfWork, reservationId: string) {
    const [reservation] = await u.tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId))
      .limit(1);

    if (!reservation) throw new NotFoundException('Reservation not found');

    // Opening it here is a safety net, not the normal path — check-in already did.
    // It makes check-out work for a stay that somehow lost its folio, rather than
    // stranding the guest at the desk.
    const [property] = await u.tx
      .select()
      .from(properties)
      .where(eq(properties.id, u.propertyId))
      .limit(1);

    return this.folio.openForReservation(
      u,
      reservationId,
      reservation.guestId,
      property!.currency,
    );
  }
}
