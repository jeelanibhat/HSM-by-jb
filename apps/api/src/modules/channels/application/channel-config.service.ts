import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, businessDate } from '@hotelos/domain';
import { and, asc, desc, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { TransactionalUnitOfWork, type ActorContext, type UnitOfWork } from '../../../shared';
import { properties } from '../../property/infra/schema';
import { ratePlans, roomTypes } from '../../inventory/infra/schema';
import {
  channelBookings,
  channelOutbound,
  channelRatePlanMappings,
  channelRoomTypeMappings,
  channels,
} from '../infra/schema';

/** How far ahead a manual resync pushes availability. */
const RESYNC_HORIZON_DAYS = 30;

/**
 * Channel configuration: connecting a channel, mapping our room types and rate plans to
 * its codes, and turning it on. Nothing here talks to an OTA — it is the setup a manager
 * does before any availability flows.
 */
@Injectable()
export class ChannelConfigService {
  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly tx: TenantTransaction,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async listChannels(propertyId: string) {
    return this.tx.run(propertyId, async (tx) => {
      const rows = await tx.select().from(channels).orderBy(asc(channels.name));
      return Promise.all(rows.map((c) => this.withMappings(tx, c)));
    });
  }

  async getChannel(propertyId: string, channelId: string) {
    return this.tx.run(propertyId, async (tx) => {
      const [channel] = await tx.select().from(channels).where(eq(channels.id, channelId)).limit(1);
      if (!channel) throw new NotFoundException('Channel not found');
      return this.withMappings(tx, channel);
    });
  }

  /** The inbound delivery log — what each channel has sent and what became of it. */
  async listBookings(propertyId: string, channelId?: string) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select()
        .from(channelBookings)
        .where(channelId ? eq(channelBookings.channelId, channelId) : undefined)
        .orderBy(desc(channelBookings.createdAt))
        .limit(100),
    );
  }

  /**
   * The outbound push log — recent availability pushes and their state.
   *
   * channel_outbound is a system queue with no RLS (see migration 0023), so the property
   * filter is EXPLICIT here — the tenant GUC does not scope it for us the way it does the
   * config tables.
   */
  async listSyncLog(propertyId: string, channelId?: string) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select()
        .from(channelOutbound)
        .where(
          and(
            eq(channelOutbound.propertyId, propertyId),
            channelId ? eq(channelOutbound.channelId, channelId) : undefined,
          ),
        )
        .orderBy(desc(channelOutbound.createdAt))
        .limit(100),
    );
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  async connect(actor: ActorContext, input: { code: string; name: string }) {
    return this.uow.execute(actor, async (u) => {
      const [existing] = await u.tx
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.code, input.code))
        .limit(1);

      if (existing) throw new BadRequestException(`A channel with code ${input.code} already exists.`);

      const id = uuidv7();
      const [created] = await u.tx
        .insert(channels)
        .values({
          id,
          propertyId: actor.propertyId,
          code: input.code,
          name: input.name,
          enabled: false, // nothing sells until it is mapped AND switched on
        })
        .returning();

      u.audit({
        action: 'channel.connected',
        entityType: 'channel',
        entityId: id,
        after: { code: input.code, name: input.name },
      });

      return this.withMappings(u.tx, created!);
    });
  }

  async setEnabled(actor: ActorContext, input: { channelId: string; enabled: boolean }) {
    return this.uow.execute(actor, async (u) => {
      const channel = await this.loadChannel(u, input.channelId);

      if (input.enabled) {
        // Enabling a channel with nothing mapped would advertise rooms an OTA has no
        // code for — every push would be empty and every inbound booking rejected.
        const [mapping] = await u.tx
          .select({ id: channelRoomTypeMappings.id })
          .from(channelRoomTypeMappings)
          .where(eq(channelRoomTypeMappings.channelId, channel.id))
          .limit(1);

        if (!mapping) {
          throw new BadRequestException(
            `Map at least one room type before enabling ${channel.name}.`,
          );
        }
      }

      const [updated] = await u.tx
        .update(channels)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(eq(channels.id, channel.id))
        .returning();

      u.audit({
        action: input.enabled ? 'channel.enabled' : 'channel.disabled',
        entityType: 'channel',
        entityId: channel.id,
        before: { enabled: channel.enabled },
        after: { enabled: input.enabled },
      });

      return this.withMappings(u.tx, updated!);
    });
  }

  async mapRoomType(
    actor: ActorContext,
    input: { channelId: string; roomTypeId: string; externalRoomCode: string },
  ) {
    return this.uow.execute(actor, async (u) => {
      const channel = await this.loadChannel(u, input.channelId);

      const [roomType] = await u.tx
        .select({ id: roomTypes.id })
        .from(roomTypes)
        .where(eq(roomTypes.id, input.roomTypeId))
        .limit(1);
      if (!roomType) throw new NotFoundException('Room type not found');

      // Re-mapping a room type replaces the code; a room type maps to exactly one code
      // per channel (the unique constraint), so upsert on that key.
      await u.tx
        .insert(channelRoomTypeMappings)
        .values({
          id: uuidv7(),
          propertyId: actor.propertyId,
          channelId: channel.id,
          roomTypeId: input.roomTypeId,
          externalRoomCode: input.externalRoomCode,
        })
        .onConflictDoUpdate({
          target: [channelRoomTypeMappings.channelId, channelRoomTypeMappings.roomTypeId],
          set: { externalRoomCode: input.externalRoomCode },
        });

      u.audit({
        action: 'channel.room_type_mapped',
        entityType: 'channel',
        entityId: channel.id,
        after: { roomTypeId: input.roomTypeId, externalRoomCode: input.externalRoomCode },
      });

      return this.withMappings(u.tx, channel);
    });
  }

  async mapRatePlan(
    actor: ActorContext,
    input: { channelId: string; ratePlanId: string; externalRateCode: string },
  ) {
    return this.uow.execute(actor, async (u) => {
      const channel = await this.loadChannel(u, input.channelId);

      const [ratePlan] = await u.tx
        .select({ id: ratePlans.id })
        .from(ratePlans)
        .where(eq(ratePlans.id, input.ratePlanId))
        .limit(1);
      if (!ratePlan) throw new NotFoundException('Rate plan not found');

      await u.tx
        .insert(channelRatePlanMappings)
        .values({
          id: uuidv7(),
          propertyId: actor.propertyId,
          channelId: channel.id,
          ratePlanId: input.ratePlanId,
          externalRateCode: input.externalRateCode,
        })
        .onConflictDoUpdate({
          target: [channelRatePlanMappings.channelId, channelRatePlanMappings.ratePlanId],
          set: { externalRateCode: input.externalRateCode },
        });

      u.audit({
        action: 'channel.rate_plan_mapped',
        entityType: 'channel',
        entityId: channel.id,
        after: { ratePlanId: input.ratePlanId, externalRateCode: input.externalRateCode },
      });

      return this.withMappings(u.tx, channel);
    });
  }

  /**
   * Push everything, now.
   *
   * The outbound worker only enqueues the room types a booking TOUCHED. A resync is the
   * "the channel and I have drifted — send it all" button: it enqueues a fresh push for
   * every mapped room type over the next horizon, which the relay then delivers. Used
   * when a channel is first connected, or after an outage, and by the UI to prove the
   * pipe works on demand.
   */
  async resync(actor: ActorContext, input: { channelId: string }): Promise<{ queued: number }> {
    return this.uow.execute(actor, async (u) => {
      const channel = await this.loadChannel(u, input.channelId);
      if (!channel.enabled) {
        throw new BadRequestException(`${channel.name} is disabled — enable it before syncing.`);
      }

      const mappings = await u.tx
        .select({ roomTypeId: channelRoomTypeMappings.roomTypeId })
        .from(channelRoomTypeMappings)
        .where(eq(channelRoomTypeMappings.channelId, channel.id));

      if (mappings.length === 0) return { queued: 0 };

      const [property] = await u.tx
        .select({ businessDate: properties.businessDate })
        .from(properties)
        .where(eq(properties.id, actor.propertyId))
        .limit(1);
      if (!property) throw new NotFoundException('Property not found');

      const from = businessDate(property.businessDate);
      const to = addDays(from, RESYNC_HORIZON_DAYS);

      await u.tx.insert(channelOutbound).values(
        mappings.map((m) => ({
          id: uuidv7(),
          propertyId: actor.propertyId,
          channelId: channel.id,
          roomTypeId: m.roomTypeId,
          fromDate: from,
          toDate: to,
          status: 'PENDING' as const,
        })),
      );

      u.audit({
        action: 'channel.resync_requested',
        entityType: 'channel',
        entityId: channel.id,
        after: { roomTypes: mappings.length, from, to },
      });

      return { queued: mappings.length };
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async loadChannel(u: UnitOfWork, channelId: string) {
    const [channel] = await u.tx.select().from(channels).where(eq(channels.id, channelId)).limit(1);
    if (!channel) throw new NotFoundException('Channel not found');
    return channel;
  }

  private async withMappings(tx: UnitOfWork['tx'], channel: typeof channels.$inferSelect) {
    const [roomMappings, rateMappings] = await Promise.all([
      tx
        .select()
        .from(channelRoomTypeMappings)
        .where(eq(channelRoomTypeMappings.channelId, channel.id)),
      tx
        .select()
        .from(channelRatePlanMappings)
        .where(eq(channelRatePlanMappings.channelId, channel.id)),
    ]);

    return { ...channel, roomTypeMappings: roomMappings, ratePlanMappings: rateMappings };
  }
}
