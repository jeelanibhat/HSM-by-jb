import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { businessDate, nextPushDelayMs } from '@hotelos/domain';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Env } from '../../../config/env';
import { TenantTransaction, type TenantTx } from '../../../db/tenant-transaction';
import { AvailabilityService } from '../../reservations';
import { ratePrices } from '../../inventory/infra/schema';
import {
  channelOutbound,
  channelRatePlanMappings,
  channelRoomTypeMappings,
  channels,
} from '../infra/schema';
import { CHANNEL_CONNECTOR, type AriUpdate, type ChannelConnector } from './connector';

/**
 * Channel sync relay — drains `channel_outbound` and pushes availability to the OTAs.
 *
 * This is the half that touches the network, split off from the outbound worker on
 * purpose (see that file). It mirrors the outbox relay: a chained poller, gated by
 * config, drained explicitly by tests.
 *
 * The one twist over the outbox relay is TENANCY. `channel_outbound` is a cross-tenant
 * system queue (no RLS), but the availability it must read IS tenant-scoped. So the relay
 * cannot compute a push in the same breath as claiming it cross-tenant. Instead it finds
 * which properties have due work, then processes each property inside its OWN scoped
 * transaction — where the availability query returns that hotel's real numbers and the
 * push cannot possibly carry another hotel's inventory.
 */
@Injectable()
export class ChannelSyncRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChannelSyncRelay.name);

  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopped = false;

  constructor(
    private readonly tx: TenantTransaction,
    private readonly availability: AvailabilityService,
    @Inject(CHANNEL_CONNECTOR) private readonly connector: ChannelConnector,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get('CHANNEL_RELAY_ENABLED', { infer: true }) === false) {
      this.logger.log('Channel sync relay disabled by config.');
      return;
    }

    const interval = this.config.get('CHANNEL_POLL_MS', { infer: true });

    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.drainOnce();
      } catch (err) {
        this.logger.error(
          `Channel sync drain failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!this.stopped) this.timer = setTimeout(() => void tick(), interval);
    };

    this.timer = setTimeout(() => void tick(), interval);
    this.logger.log(`Channel sync relay started (poll ${interval}ms).`);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * One full pass: every property that has a due push, processed under its own scope.
   * Returns the number of pushes that succeeded — used by tests and by the caller.
   */
  async drainOnce(): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;

    try {
      const propertyIds = await this.propertiesWithDuePushes();
      let sent = 0;
      for (const propertyId of propertyIds) {
        sent += await this.drainProperty(propertyId);
      }
      return sent;
    } finally {
      this.draining = false;
    }
  }

  /**
   * Which properties have a PENDING push whose back-off has elapsed.
   *
   * Read WITHOUT a tenant scope — this is the one cross-tenant read, and it is safe
   * because channel_outbound carries no tenant data beyond ids and dates. Everything
   * downstream re-enters a proper scope.
   */
  private async propertiesWithDuePushes(): Promise<string[]> {
    return this.tx.runWithoutTenantScope(async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT DISTINCT property_id::text AS "propertyId"
        FROM channel.channel_outbound
        WHERE status = 'PENDING' AND next_attempt_at <= now()
      `)) as unknown as Array<{ propertyId: string }>;
      return rows.map((r) => r.propertyId);
    });
  }

  private async drainProperty(propertyId: string): Promise<number> {
    return this.tx.run(propertyId, async (tx) => {
      // Claim this property's due pushes. FOR UPDATE SKIP LOCKED so a second relay
      // replica grabs a disjoint set rather than blocking on ours. The scope is set, but
      // channel_outbound has no RLS, so the property filter is explicit.
      const due = await tx
        .select()
        .from(channelOutbound)
        .where(
          and(
            eq(channelOutbound.propertyId, propertyId),
            eq(channelOutbound.status, 'PENDING'),
            lte(channelOutbound.nextAttemptAt, new Date()),
          ),
        )
        .orderBy(channelOutbound.createdAt)
        .limit(100)
        .for('update', { skipLocked: true });

      let sent = 0;
      for (const row of due) {
        if (await this.pushOne(tx, propertyId, row)) sent += 1;
      }
      return sent;
    });
  }

  /**
   * Compute and push one queued row's ARI, then record the outcome.
   *
   * A push is the CURRENT availability over the row's night range — recomputed here, not
   * carried on the row — so however many bookings and cancellations piled up between
   * enqueue and now, the OTA hears the truth as it stands.
   */
  private async pushOne(
    tx: TenantTx,
    propertyId: string,
    row: typeof channelOutbound.$inferSelect,
  ): Promise<boolean> {
    const [channel] = await tx.select().from(channels).where(eq(channels.id, row.channelId)).limit(1);

    // A channel disabled or deleted since the push was queued has nothing to hear it.
    if (!channel || !channel.enabled) {
      await tx
        .update(channelOutbound)
        .set({ status: 'SENT', sentAt: new Date(), lastError: 'channel disabled; push skipped' })
        .where(eq(channelOutbound.id, row.id));
      return false;
    }

    const updates = await this.buildAri(tx, propertyId, row);

    try {
      await this.connector.pushAri(
        { channelId: channel.id, code: channel.code, credentials: channel.credentials as Record<string, unknown> },
        updates,
      );

      await tx
        .update(channelOutbound)
        .set({ status: 'SENT', sentAt: new Date(), lastError: null })
        .where(eq(channelOutbound.id, row.id));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.attempts + 1;

      // Back on the queue, later. The push stays PENDING; next_attempt_at holds it off
      // until the back-off elapses, and a persistent failure just keeps its distance.
      await tx
        .update(channelOutbound)
        .set({
          status: 'PENDING',
          attempts,
          lastError: message,
          nextAttemptAt: new Date(Date.now() + nextPushDelayMs(attempts)),
        })
        .where(eq(channelOutbound.id, row.id));

      this.logger.warn(`Push to ${channel.code} failed (attempt ${attempts}): ${message}`);
      return false;
    }
  }

  /** Translate our availability + rates for the row's range into the channel's codes. */
  private async buildAri(
    tx: TenantTx,
    propertyId: string,
    row: typeof channelOutbound.$inferSelect,
  ): Promise<AriUpdate[]> {
    const [roomMap] = await tx
      .select({ code: channelRoomTypeMappings.externalRoomCode })
      .from(channelRoomTypeMappings)
      .where(
        and(
          eq(channelRoomTypeMappings.channelId, row.channelId),
          eq(channelRoomTypeMappings.roomTypeId, row.roomTypeId),
        ),
      )
      .limit(1);

    // The mapping was removed between enqueue and now — nothing to translate to.
    if (!roomMap) return [];

    const avail = await this.availability.queryWith(
      tx,
      propertyId,
      businessDate(row.fromDate),
      businessDate(row.toDate),
      row.roomTypeId,
    );

    // A rate to send alongside availability is a bonus, not a requirement: a channel may
    // manage its own rates. If a rate plan is mapped, attach the nightly price.
    // The oldest mapped plan, deterministically — a channel with two mapped plans must
    // not have its advertised price flip between pushes on Postgres row order.
    const [rateMap] = await tx
      .select({
        externalRateCode: channelRatePlanMappings.externalRateCode,
        ratePlanId: channelRatePlanMappings.ratePlanId,
      })
      .from(channelRatePlanMappings)
      .where(eq(channelRatePlanMappings.channelId, row.channelId))
      .orderBy(asc(channelRatePlanMappings.createdAt))
      .limit(1);

    const priceByDate = new Map<string, number>();
    if (rateMap) {
      // Only the nights being pushed — not every priced day for the plan.
      const prices = await tx
        .select({ date: ratePrices.date, priceMinor: ratePrices.priceMinor })
        .from(ratePrices)
        .where(
          and(
            eq(ratePrices.ratePlanId, rateMap.ratePlanId),
            eq(ratePrices.roomTypeId, row.roomTypeId),
            gte(ratePrices.date, row.fromDate),
            lte(ratePrices.date, row.toDate),
          ),
        );
      for (const p of prices) priceByDate.set(p.date, p.priceMinor);
    }

    return avail.map((a) => ({
      externalRoomCode: roomMap.code,
      externalRateCode: rateMap?.externalRateCode ?? null,
      date: a.date,
      available: a.available,
      priceMinor: priceByDate.get(a.date) ?? null,
    }));
  }
}
