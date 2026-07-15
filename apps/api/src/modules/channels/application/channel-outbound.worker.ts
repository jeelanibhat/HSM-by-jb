import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { addDays, businessDate } from '@hotelos/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TenantTransaction, type TenantTx } from '../../../db/tenant-transaction';
import { EventBus, type PublishedEvent } from '../../../shared';
import { channelOutbound, channelRoomTypeMappings, channels } from '../infra/schema';

/**
 * Turns "inventory moved" into "the channels need to hear about it".
 *
 * It listens for the reservation events that change availability and, for each affected
 * room type, enqueues one outbound push per enabled+mapped channel. It does the CHEAP,
 * reliable half — an insert — and nothing else. The actual call to the OTA is the sync
 * relay's job, deliberately, because:
 *
 *   This handler runs off the outbox relay, and the outbox leaves an event UNPROCESSED
 *   (and retries it forever) if a handler throws. If this worker called a flaky OTA and
 *   that OTA was down, the reservation's whole event — including the tape-chart redraw —
 *   would be stuck in a retry loop. So an OTA outage must never reach here. Enqueue,
 *   return, let the relay deal with the network.
 */
@Injectable()
export class ChannelOutboundWorker implements OnModuleInit {
  private readonly logger = new Logger(ChannelOutboundWorker.name);

  constructor(
    private readonly bus: EventBus,
    private readonly tx: TenantTransaction,
  ) {}

  onModuleInit(): void {
    for (const type of ['reservation.created', 'reservation.modified', 'reservation.cancelled'] as const) {
      this.bus.on(type, (event) => this.onReservationChange(event));
    }
  }

  private async onReservationChange(event: PublishedEvent): Promise<void> {
    if (!event.propertyId) return;

    try {
      await this.enqueueForReservation(event.propertyId, event.aggregateId, event.payload);
    } catch (err) {
      // Never rethrow: a failure to enqueue must not wedge the outbox. We would rather
      // miss one push (the next booking re-triggers it) than stall every event.
      this.logger.error(
        `Failed to enqueue channel pushes for reservation ${event.aggregateId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Enqueue the pushes for one reservation's rooms.
   *
   * The room types and dates come from `reservation_rooms`, not the event payload — the
   * payload carries a count, not the types, and the rows are present for created,
   * modified and cancelled alike. The push RANGE is the occupied nights
   * (arrival … departure − 1); the relay recomputes the *current* availability over that
   * range, so a cancellation and a booking enqueue the same shape and the snapshot sorts
   * out which way it moved.
   */
  private async enqueueForReservation(
    propertyId: string,
    reservationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.tx.run(propertyId, async (tx) => {
      const spans = await this.roomTypeSpans(tx, reservationId);
      if (spans.length === 0) return;

      // A date change frees the OLD nights and books the new ones. The current rooms only
      // describe the new range, so widen each span to also cover where the reservation
      // USED to be (carried on reservation.modified) — otherwise the vacated nights stay
      // closed on the channel forever. The relay recomputes current availability across
      // the widened range, so the freed nights come back and the new ones close in one push.
      const widened = this.widenToPrevious(spans, payload);

      const roomTypeIds = widened.map((s) => s.roomTypeId);

      // Enabled channels that actually map one of these room types. A disabled channel,
      // or one with no mapping for the type, has nothing to be told.
      const targets = await tx
        .select({
          channelId: channels.id,
          roomTypeId: channelRoomTypeMappings.roomTypeId,
        })
        .from(channels)
        .innerJoin(channelRoomTypeMappings, eq(channelRoomTypeMappings.channelId, channels.id))
        .where(
          and(
            eq(channels.enabled, true),
            inArray(channelRoomTypeMappings.roomTypeId, roomTypeIds),
          ),
        );

      if (targets.length === 0) return;

      const spanByType = new Map(widened.map((s) => [s.roomTypeId, s]));

      const rows = targets.map((t) => {
        const span = spanByType.get(t.roomTypeId)!;
        return {
          id: uuidv7(),
          propertyId,
          channelId: t.channelId,
          roomTypeId: t.roomTypeId,
          fromDate: span.fromDate,
          toDate: span.toDate,
          status: 'PENDING' as const,
        };
      });

      await tx.insert(channelOutbound).values(rows);
    });
  }

  /**
   * Stretch each span to also cover the reservation's PREVIOUS nights, if the event
   * carried them (only reservation.modified does). ISO dates compare lexicographically,
   * so string min/max is correct here.
   */
  private widenToPrevious(
    spans: Array<{ roomTypeId: string; fromDate: string; toDate: string }>,
    payload: Record<string, unknown>,
  ): Array<{ roomTypeId: string; fromDate: string; toDate: string }> {
    const prevArrival = typeof payload['previousArrival'] === 'string' ? payload['previousArrival'] : null;
    const prevDeparture =
      typeof payload['previousDeparture'] === 'string' ? payload['previousDeparture'] : null;

    if (!prevArrival || !prevDeparture) return spans;

    const prevLastNight = addDays(businessDate(prevDeparture), -1);

    return spans.map((s) => ({
      roomTypeId: s.roomTypeId,
      fromDate: prevArrival < s.fromDate ? prevArrival : s.fromDate,
      toDate: prevLastNight > s.toDate ? prevLastNight : s.toDate,
    }));
  }

  /** Per room type on the reservation: the widest occupied-night span across its rows. */
  private async roomTypeSpans(
    tx: TenantTx,
    reservationId: string,
  ): Promise<Array<{ roomTypeId: string; fromDate: string; toDate: string }>> {
    const rows = (await tx.execute(sql`
      SELECT room_type_id::text AS "roomTypeId",
             min(arrival_date)::text AS "arrival",
             max(departure_date)::text AS "departure"
      FROM reservations.reservation_rooms
      WHERE reservation_id = ${reservationId}
      GROUP BY room_type_id
    `)) as unknown as Array<{ roomTypeId: string; arrival: string; departure: string }>;

    return rows.map((r) => ({
      roomTypeId: r.roomTypeId,
      fromDate: r.arrival,
      // Nights occupied are arrival … departure − 1; the departure day is not sold.
      toDate: addDays(businessDate(r.departure), -1),
    }));
  }
}
