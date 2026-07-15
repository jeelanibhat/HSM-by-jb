import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  assertTransition,
  businessDate,
  IllegalTransitionError,
  nightsBetween,
  occupiesInventory,
  type ReservationSource,
  type ReservationStatus,
} from '@hotelos/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { TransactionalUnitOfWork, type ActorContext, type UnitOfWork } from '../../../shared';
import { rooms } from '../../inventory/infra/schema';
import { guests } from '../../guests/infra/schema';
import { reservationRooms, reservations } from '../infra/schema';
import { AvailabilityService, NoAvailabilityError } from './availability.service';

/** Postgres exclusion-constraint violation — the double-booking guard firing. */
const EXCLUSION_VIOLATION = '23P01';

function isExclusionViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && err.code === EXCLUSION_VIOLATION
  );
}

export interface CreateReservationInput {
  guestId?: string;
  guest?: { firstName: string; lastName: string; email?: string; phone?: string };
  source: ReservationSource;
  arrivalDate: string;
  departureDate: string;
  rooms: Array<{ roomTypeId: string; ratePlanId: string; adults: number; children: number }>;
  notes?: string;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly tx: TenantTransaction,
    private readonly availability: AvailabilityService,
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async create(actor: ActorContext, input: CreateReservationInput) {
    const arrival = businessDate(input.arrivalDate);
    const departure = businessDate(input.departureDate);

    // Throws if departure <= arrival. Mirrors the DB CHECK; we would rather fail
    // here with a sentence a human wrote than with a constraint name.
    nightsBetween(arrival, departure);

    return this.uow.execute(actor, async (u) => {
      const guestId = await this.resolveGuest(u, input);

      // Hold inventory FIRST, before writing anything. Every room's counter is
      // moved under a row lock, so a concurrent booking for the last room blocks
      // here and then correctly finds nothing left.
      for (const room of input.rooms) {
        try {
          await this.availability.adjustSold(u, room.roomTypeId, arrival, departure, +1);
        } catch (err) {
          if (err instanceof NoAvailabilityError) {
            throw new ConflictException(err.message);
          }
          throw err;
        }
      }

      const confirmationNo = await this.nextConfirmationNo(u);
      const reservationId = uuidv7();

      const [reservation] = await u.tx
        .insert(reservations)
        .values({
          id: reservationId,
          propertyId: actor.propertyId,
          confirmationNo,
          guestId,
          status: 'CONFIRMED',
          source: input.source,
          arrivalDate: arrival,
          departureDate: departure,
          adults: input.rooms.reduce((s, r) => s + r.adults, 0),
          children: input.rooms.reduce((s, r) => s + r.children, 0),
          notes: input.notes ?? null,
          createdBy: actor.userId,
        })
        .returning();

      const lines = await u.tx
        .insert(reservationRooms)
        .values(
          input.rooms.map((r) => ({
            id: uuidv7(),
            propertyId: actor.propertyId,
            reservationId,
            roomTypeId: r.roomTypeId,
            // roomId stays NULL — we sold a room TYPE. The physical room is assigned
            // later, and only then does the exclusion constraint have anything to
            // enforce.
            roomId: null,
            ratePlanId: r.ratePlanId,
            arrivalDate: arrival,
            departureDate: departure,
            status: 'CONFIRMED' as const,
            adults: r.adults,
            children: r.children,
          })),
        )
        .returning();

      u.audit({
        action: 'reservation.created',
        entityType: 'reservation',
        entityId: reservationId,
        after: { confirmationNo, arrival, departure, rooms: input.rooms.length },
      });

      u.emit({
        aggregateType: 'reservation',
        aggregateId: reservationId,
        eventType: 'reservation.created',
        payload: { confirmationNo, guestId, arrival, departure, rooms: input.rooms.length },
      });

      // Return the rooms with the reservation — the caller needs the reservation_room
      // ids to assign physical rooms, and a second round-trip to fetch them would
      // be a needless query on the booking path.
      return { ...reservation!, rooms: lines };
    });
  }

  // ── Cancel ────────────────────────────────────────────────────────────────

  /**
   * Cancelling RELEASES the inventory it was holding — the counters must come back
   * down, or the hotel slowly "sells out" while sitting half empty (TDD §8.2:
   * "cancellation restoring counters").
   */
  async cancel(actor: ActorContext, reservationId: string, reason: string) {
    return this.uow.execute(actor, async (u) => {
      const reservation = await this.loadForUpdate(u, reservationId);

      try {
        // CHECKED_IN → CANCELLED is illegal: the guest is in the building and has
        // a folio. They check out; they are not cancelled.
        assertTransition(reservation.status as ReservationStatus, 'CANCELLED');
      } catch (err) {
        if (err instanceof IllegalTransitionError) throw new BadRequestException(err.message);
        throw err;
      }

      const held = await u.tx
        .select()
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, reservationId));

      for (const room of held) {
        // Only rooms that were actually holding inventory give any back. Releasing
        // a room twice would drive `sold` negative — the DB CHECK would catch it,
        // but we should not be relying on that.
        if (!occupiesInventory(room.status as ReservationStatus)) continue;

        await this.availability.adjustSold(
          u,
          room.roomTypeId,
          businessDate(room.arrivalDate),
          businessDate(room.departureDate),
          -1,
        );
      }

      await u.tx
        .update(reservationRooms)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(reservationRooms.reservationId, reservationId));

      const [updated] = await u.tx
        .update(reservations)
        .set({
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(reservations.id, reservationId))
        .returning();

      u.audit({
        action: 'reservation.cancelled',
        entityType: 'reservation',
        entityId: reservationId,
        before: { status: reservation.status },
        after: { status: 'CANCELLED' },
        reason,
      });

      u.emit({
        aggregateType: 'reservation',
        aggregateId: reservationId,
        eventType: 'reservation.cancelled',
        payload: { confirmationNo: reservation.confirmationNo, reason },
      });

      return updated!;
    });
  }

  // ── Modify dates ──────────────────────────────────────────────────────────

  /**
   * Change the stay dates.
   *
   * Implemented as release-then-hold rather than a diff of the two ranges. A diff
   * is a nest of edge cases (shrink at the front, grow at the back, move entirely,
   * overlap partially) and every one of them is a chance to leak a counter. Both
   * halves run in ONE transaction, so if the new dates are unavailable the release
   * is rolled back too — the guest keeps the booking they already had rather than
   * losing it to a failed change.
   */
  async modifyDates(
    actor: ActorContext,
    reservationId: string,
    newArrival: string,
    newDeparture: string,
  ) {
    const arrival = businessDate(newArrival);
    const departure = businessDate(newDeparture);
    nightsBetween(arrival, departure);

    return this.uow.execute(actor, async (u) => {
      const reservation = await this.loadForUpdate(u, reservationId);

      const status = reservation.status as ReservationStatus;
      if (status !== 'CONFIRMED' && status !== 'ENQUIRY' && status !== 'CHECKED_IN') {
        throw new BadRequestException(`A ${status} reservation cannot be modified.`);
      }

      const held = await u.tx
        .select()
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, reservationId));

      // Release the old range...
      for (const room of held) {
        if (!occupiesInventory(room.status as ReservationStatus)) continue;
        await this.availability.adjustSold(
          u,
          room.roomTypeId,
          businessDate(room.arrivalDate),
          businessDate(room.departureDate),
          -1,
        );
      }

      // ...then take the new one. If this throws, the whole transaction rolls back
      // and the guest still has their original booking.
      for (const room of held) {
        if (!occupiesInventory(room.status as ReservationStatus)) continue;
        try {
          await this.availability.adjustSold(u, room.roomTypeId, arrival, departure, +1);
        } catch (err) {
          if (err instanceof NoAvailabilityError) {
            throw new ConflictException(
              `Cannot extend to those dates — ${err.message} The original booking is unchanged.`,
            );
          }
          throw err;
        }
      }

      await u.tx
        .update(reservationRooms)
        .set({ arrivalDate: arrival, departureDate: departure, updatedAt: new Date() })
        .where(eq(reservationRooms.reservationId, reservationId));

      const [updated] = await u.tx
        .update(reservations)
        .set({ arrivalDate: arrival, departureDate: departure, updatedAt: new Date() })
        .where(eq(reservations.id, reservationId))
        .returning();

      u.audit({
        action: 'reservation.modified',
        entityType: 'reservation',
        entityId: reservationId,
        before: {
          arrivalDate: reservation.arrivalDate,
          departureDate: reservation.departureDate,
        },
        after: { arrivalDate: arrival, departureDate: departure },
      });

      u.emit({
        aggregateType: 'reservation',
        aggregateId: reservationId,
        eventType: 'reservation.modified',
        payload: {
          confirmationNo: reservation.confirmationNo,
          arrival,
          departure,
          // The dates BEFORE the move. Consumers that mirror availability (the channel
          // manager) must refresh the vacated nights too, not only the new ones — a room
          // freed by a date change is a room the OTA should be able to sell again.
          previousArrival: reservation.arrivalDate,
          previousDeparture: reservation.departureDate,
        },
      });

      return updated!;
    });
  }

  // ── Assign a physical room ────────────────────────────────────────────────

  /**
   * Pin a booking to a specific room. THIS is where the exclusion constraint bites.
   *
   * We check for a clash in application code first, to give a decent message. But
   * the check-then-write is a race: two clerks assigning room 101 at the same
   * instant both pass the check. The constraint is what actually saves us, and the
   * 23P01 handler below is not a fallback — it is the real defence. The friendly
   * message is the nicety.
   */
  async assignRoom(actor: ActorContext, reservationRoomId: string, roomId: string) {
    return this.uow.execute(actor, async (u) => {
      const [line] = await u.tx
        .select()
        .from(reservationRooms)
        .where(eq(reservationRooms.id, reservationRoomId))
        .limit(1)
        .for('update');

      if (!line) throw new NotFoundException('Reservation room not found');

      if (!occupiesInventory(line.status as ReservationStatus)) {
        throw new BadRequestException(`Cannot assign a room to a ${line.status} booking.`);
      }

      const [room] = await u.tx.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
      if (!room) throw new NotFoundException('Room not found');

      // Selling a Deluxe and handing over a Standard is a complaint at check-out.
      if (room.roomTypeId !== line.roomTypeId) {
        throw new BadRequestException('That room is not of the booked room type.');
      }

      if (room.status === 'OOO' || room.status === 'OOS') {
        throw new BadRequestException(`Room ${room.number} is out of order.`);
      }

      try {
        const [updated] = await u.tx
          .update(reservationRooms)
          .set({ roomId, updatedAt: new Date() })
          .where(eq(reservationRooms.id, reservationRoomId))
          .returning();

        u.audit({
          action: 'reservation.room_assigned',
          entityType: 'reservation_room',
          entityId: reservationRoomId,
          before: { roomId: line.roomId },
          after: { roomId, roomNumber: room.number },
        });

        return updated!;
      } catch (err) {
        if (isExclusionViolation(err)) {
          // The database refused to double-book. Not a 500 — a real, expected
          // domain outcome that the front desk needs stated plainly.
          throw new ConflictException(
            `Room ${room.number} is already booked for overlapping dates.`,
          );
        }
        throw err;
      }
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async findById(propertyId: string, id: string) {
    return this.tx.run(propertyId, async (tx) => {
      const [reservation] = await tx
        .select()
        .from(reservations)
        .where(eq(reservations.id, id))
        .limit(1);
      if (!reservation) return null;

      const lines = await tx
        .select()
        .from(reservationRooms)
        .where(eq(reservationRooms.reservationId, id));

      return { ...reservation, rooms: lines };
    });
  }

  async list(propertyId: string, status?: ReservationStatus) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select()
        .from(reservations)
        .where(status ? eq(reservations.status, status) : undefined)
        .orderBy(asc(reservations.arrivalDate))
        .limit(200),
    );
  }

  /** Arrivals for a business date — the front desk's morning list (TDD §5.2). */
  async arrivals(propertyId: string, date: string) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select()
        .from(reservations)
        .where(and(eq(reservations.arrivalDate, date), eq(reservations.status, 'CONFIRMED')))
        .orderBy(asc(reservations.confirmationNo)),
    );
  }

  async departures(propertyId: string, date: string) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select()
        .from(reservations)
        .where(and(eq(reservations.departureDate, date), eq(reservations.status, 'CHECKED_IN')))
        .orderBy(asc(reservations.confirmationNo)),
    );
  }

  async availabilityGrid(propertyId: string, from: string, to: string, roomTypeId?: string) {
    return this.uow.execute({ propertyId, userId: SYSTEM_USER }, (u) =>
      this.availability.query(u, businessDate(from), businessDate(to), roomTypeId),
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

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

  private async resolveGuest(u: UnitOfWork, input: CreateReservationInput): Promise<string> {
    if (input.guestId) {
      const [existing] = await u.tx
        .select()
        .from(guests)
        .where(eq(guests.id, input.guestId))
        .limit(1);

      if (!existing) throw new NotFoundException('Guest not found');
      if (existing.blacklisted) {
        throw new BadRequestException('That guest is blacklisted at this property.');
      }
      return existing.id;
    }

    if (!input.guest) {
      throw new BadRequestException('Provide either an existing guestId or new guest details.');
    }

    const id = uuidv7();
    await u.tx.insert(guests).values({
      id,
      propertyId: u.propertyId,
      firstName: input.guest.firstName,
      lastName: input.guest.lastName,
      email: input.guest.email ?? null,
      phone: input.guest.phone ?? null,
    });

    u.audit({ action: 'guest.created', entityType: 'guest', entityId: id, after: input.guest });

    return id;
  }

  /**
   * Human-facing booking reference. Drawn from a Postgres sequence, so two
   * properties booking in the same millisecond cannot collide — and it is short
   * enough to read down a phone line.
   */
  private async nextConfirmationNo(u: UnitOfWork): Promise<string> {
    const rows = (await u.tx.execute(
      sql`SELECT nextval('reservations.confirmation_seq') AS n`,
    )) as unknown as Array<{ n: string }>;

    return `HTL-${rows[0]!.n}`;
  }
}

/** Availability reads are not attributable to a person; nothing is written. */
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
