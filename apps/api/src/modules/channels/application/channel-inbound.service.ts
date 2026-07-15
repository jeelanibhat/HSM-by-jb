import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { ReservationsService } from '../../reservations';
import { TransactionalUnitOfWork, type ActorContext } from '../../../shared';
import { channelBookings, channelRatePlanMappings, channelRoomTypeMappings, channels } from '../infra/schema';

export interface IngestInput {
  channelId: string;
  externalRef: string;
  externalRoomCode: string;
  externalRateCode: string;
  guest: { firstName: string; lastName: string; email?: string; phone?: string };
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
}

export type IngestOutcome = 'CONFIRMED' | 'REJECTED' | 'DUPLICATE';

export interface IngestResult {
  outcome: IngestOutcome;
  bookingId: string;
  externalRef: string;
  reservationId?: string;
  confirmationNo?: string;
  reason?: string;
}

/**
 * Turns a booking an OTA delivered into one of our reservations — or records, precisely,
 * why it could not.
 *
 * The whole module points at the guarantee this service makes: a booking the channel
 * believes it made either becomes a real reservation the front desk will see, or is
 * REJECTED with a reason a human can act on. It never silently half-happens. The three
 * failure modes are all real:
 *
 *   DUPLICATE — the OTA redelivered a booking we already have. The reservation from the
 *               first delivery stands; we make nothing new. This is why the unique key on
 *               (channel, external_ref) exists.
 *   REJECTED (no mapping) — the channel named a room or rate code we have not mapped. We
 *               will not guess which of our rooms it meant.
 *   REJECTED (no room) — the room is gone. The reservation engine's exclusion guard fires
 *               exactly as it does for a walk-in, and we surface it rather than oversell.
 */
@Injectable()
export class ChannelInboundService {
  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly reservations: ReservationsService,
  ) {}

  async ingest(actor: ActorContext, input: IngestInput): Promise<IngestResult> {
    // 1. Record the delivery. The unique (channel, external_ref) turns a redelivery into
    //    a no-op here: onConflictDoNothing returns nothing, and we report DUPLICATE
    //    without touching the reservation the first delivery created.
    const receipt = await this.recordReceipt(actor, input);
    if (receipt.duplicate) {
      return { outcome: 'DUPLICATE', bookingId: receipt.bookingId, externalRef: input.externalRef };
    }
    const bookingId = receipt.bookingId;

    // 2. Translate the channel's codes to our ids. We refuse to guess.
    const mapping = await this.resolveMapping(actor, input);
    if (!mapping) {
      const reason = `Unknown mapping for room "${input.externalRoomCode}" / rate "${input.externalRateCode}".`;
      await this.reject(actor, bookingId, reason);
      return { outcome: 'REJECTED', bookingId, externalRef: input.externalRef, reason };
    }

    // 3. Book it through the ordinary reservation engine — same availability hold, same
    //    oversell guard, same events. It is an OTA booking only by its `source`.
    try {
      const reservation = await this.reservations.create(actor, {
        guest: input.guest,
        source: 'OTA',
        arrivalDate: input.arrivalDate,
        departureDate: input.departureDate,
        rooms: [
          {
            roomTypeId: mapping.roomTypeId,
            ratePlanId: mapping.ratePlanId,
            adults: input.adults,
            children: input.children,
          },
        ],
      });

      await this.confirm(actor, bookingId, reservation.id, input.externalRef);
      return {
        outcome: 'CONFIRMED',
        bookingId,
        externalRef: input.externalRef,
        reservationId: reservation.id,
        confirmationNo: reservation.confirmationNo,
      };
    } catch (err) {
      // The room sold out from under the OTA between search and book — the classic
      // oversell, caught by the exclusion guard and surfaced instead of forced through.
      if (err instanceof ConflictException) {
        const reason = err.message;
        await this.reject(actor, bookingId, reason);
        return { outcome: 'REJECTED', bookingId, externalRef: input.externalRef, reason };
      }
      throw err;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async recordReceipt(
    actor: ActorContext,
    input: IngestInput,
  ): Promise<{ duplicate: boolean; bookingId: string }> {
    return this.uow.execute(actor, async (u) => {
      const [channel] = await u.tx
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.id, input.channelId))
        .limit(1);
      if (!channel) throw new NotFoundException('Channel not found');

      const id = uuidv7();
      const [inserted] = await u.tx
        .insert(channelBookings)
        .values({
          id,
          propertyId: actor.propertyId,
          channelId: input.channelId,
          externalRef: input.externalRef,
          status: 'RECEIVED',
          rawPayload: input as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing({
          target: [channelBookings.channelId, channelBookings.externalRef],
        })
        .returning({ id: channelBookings.id });

      if (!inserted) {
        // The ref already exists — a redelivery. Find the row we already have.
        const [existing] = await u.tx
          .select({ id: channelBookings.id })
          .from(channelBookings)
          .where(
            and(
              eq(channelBookings.channelId, input.channelId),
              eq(channelBookings.externalRef, input.externalRef),
            ),
          )
          .limit(1);

        return { duplicate: true, bookingId: existing!.id };
      }

      return { duplicate: false, bookingId: id };
    });
  }

  private async resolveMapping(
    actor: ActorContext,
    input: IngestInput,
  ): Promise<{ roomTypeId: string; ratePlanId: string } | null> {
    return this.uow.execute(actor, async (u) => {
      const [room] = await u.tx
        .select({ roomTypeId: channelRoomTypeMappings.roomTypeId })
        .from(channelRoomTypeMappings)
        .where(
          and(
            eq(channelRoomTypeMappings.channelId, input.channelId),
            eq(channelRoomTypeMappings.externalRoomCode, input.externalRoomCode),
          ),
        )
        .limit(1);
      if (!room) return null;

      const [rate] = await u.tx
        .select({ ratePlanId: channelRatePlanMappings.ratePlanId })
        .from(channelRatePlanMappings)
        .where(
          and(
            eq(channelRatePlanMappings.channelId, input.channelId),
            eq(channelRatePlanMappings.externalRateCode, input.externalRateCode),
          ),
        )
        .limit(1);
      if (!rate) return null;

      return { roomTypeId: room.roomTypeId, ratePlanId: rate.ratePlanId };
    });
  }

  private async confirm(
    actor: ActorContext,
    bookingId: string,
    reservationId: string,
    externalRef: string,
  ): Promise<void> {
    await this.uow.execute(actor, async (u) => {
      await u.tx
        .update(channelBookings)
        .set({ status: 'CONFIRMED', reservationId })
        .where(eq(channelBookings.id, bookingId));

      u.audit({
        action: 'channel.booking_confirmed',
        entityType: 'channel_booking',
        entityId: bookingId,
        after: { externalRef, reservationId },
      });

      u.emit({
        aggregateType: 'channel_booking',
        aggregateId: bookingId,
        eventType: 'channel.booking_received',
        payload: { bookingId, externalRef, reservationId },
      });
    });
  }

  private async reject(actor: ActorContext, bookingId: string, reason: string): Promise<void> {
    await this.uow.execute(actor, async (u) => {
      await u.tx
        .update(channelBookings)
        .set({ status: 'REJECTED', reason })
        .where(eq(channelBookings.id, bookingId));

      u.audit({
        action: 'channel.booking_rejected',
        entityType: 'channel_booking',
        entityId: bookingId,
        after: { reason },
      });
    });
  }
}
