import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { asc, count, inArray, isNull } from 'drizzle-orm';
import type { Env } from '../../config/env';
import { DB, type Database } from '../../db/db.tokens';
import { outboxEvents } from '../../db/schema/shared';
import { EventBus } from '../events/event-bus';
import type { EventType, PublishedEvent } from '../events/domain-event';

/**
 * Outbox relay — drains `shared.outbox_events` and publishes to the EventBus.
 *
 * Delivery is AT-LEAST-ONCE, deliberately. We publish, then mark processed. A
 * crash between those two steps replays the event next tick. The alternative
 * (mark first, then publish) loses events on a crash — and a lost
 * `reservation.checked_in` means housekeeping never learns the room is occupied.
 * Duplicates are recoverable; lost events are not. Handlers must be idempotent.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxRelay.name);

  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopped = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly bus: EventBus,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get('OUTBOX_RELAY_ENABLED', { infer: true }) === false) {
      this.logger.log('Outbox relay disabled by config.');
      return;
    }

    const interval = this.config.get('OUTBOX_POLL_MS', { infer: true });

    // setInterval would stack drains if one ran long. Chain instead: each drain
    // schedules the next only once it has finished.
    const tick = async () => {
      if (this.stopped) return;

      try {
        await this.drain();
      } catch (err) {
        this.logger.error(
          `Outbox drain failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!this.stopped) this.timer = setTimeout(() => void tick(), interval);
    };

    this.timer = setTimeout(() => void tick(), interval);
    this.logger.log(`Outbox relay started (poll ${interval}ms).`);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Drain one batch.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes this safe to run on every API replica
   * at once: each relay locks a disjoint set of rows and skips whatever a peer is
   * already holding. Without SKIP LOCKED, N replicas would either serialise on the
   * same rows or publish the same event N times.
   *
   * Returns the number of events published — used by tests, and by the "drain
   * until empty" loop below.
   */
  async drain(batchSize = 100): Promise<number> {
    // Re-entrancy guard: an in-flight drain must not be joined by the next tick.
    if (this.draining) return 0;
    this.draining = true;

    try {
      let total = 0;

      for (;;) {
        const published = await this.drainBatch(batchSize);
        total += published;

        // Stop when the batch came back short — the queue is empty.
        if (published < batchSize) break;
      }

      return total;
    } finally {
      this.draining = false;
    }
  }

  private async drainBatch(batchSize: number): Promise<number> {
    /**
     * The whole batch — claim, publish, mark — runs in ONE transaction, so the row
     * locks are held for the duration. A peer relay cannot grab the same rows while
     * we are publishing them.
     *
     * The relay is cross-tenant by nature: it drains events for every property.
     * shared.outbox_events is deliberately NOT under RLS for exactly this reason
     * (see migration 0001).
     *
     * Built with the query builder rather than raw SQL: an earlier raw version
     * interpolated a JS array into `= ANY($1::uuid[])`, which Drizzle sends as a
     * scalar parameter and Postgres rejects as a malformed array literal.
     */
    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .select()
        .from(outboxEvents)
        .where(isNull(outboxEvents.processedAt))
        .orderBy(asc(outboxEvents.createdAt)) // uuidv7 ids are time-ordered too
        .limit(batchSize)
        .for('update', { skipLocked: true });

      if (claimed.length === 0) return 0;

      const delivered: string[] = [];

      for (const row of claimed) {
        const payload = (row.payload ?? {}) as Record<string, unknown>;

        const event: PublishedEvent = {
          id: row.id,
          propertyId: String(payload['propertyId'] ?? ''),
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          eventType: row.eventType as EventType,
          payload,
          occurredAt: row.createdAt,
        };

        const { failed } = await this.bus.publish(event);

        /**
         * A handler that threw leaves the row unprocessed, so it is retried next
         * tick. That is the at-least-once contract doing its job: we would rather
         * redeliver than silently drop a check-in.
         */
        if (failed === 0) delivered.push(row.id);
      }

      if (delivered.length > 0) {
        await tx
          .update(outboxEvents)
          .set({ processedAt: new Date() })
          .where(inArray(outboxEvents.id, delivered));
      }

      return claimed.length;
    });
  }

  /** Unprocessed backlog. Exposed for the /health probe and for tests. */
  async pendingCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(outboxEvents)
      .where(isNull(outboxEvents.processedAt));

    return row?.n ?? 0;
  }
}
