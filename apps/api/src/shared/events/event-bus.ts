import { Injectable, Logger } from '@nestjs/common';
import type { EventType, PublishedEvent } from './domain-event';

export type EventHandler = (event: PublishedEvent) => Promise<void> | void;

/**
 * In-process event bus. The outbox relay is the ONLY thing that publishes to it —
 * handlers therefore see events that are already durably committed, never events
 * from a transaction that later rolled back.
 *
 * Handlers must be idempotent. The relay delivers at-least-once: a crash between
 * "handler ran" and "row marked processed" replays the event on the next tick.
 * Exactly-once would require distributed transactions we are not going to have.
 */
@Injectable()
export class EventBus {
  private readonly logger = new Logger(EventBus.name);
  private readonly handlers = new Map<EventType, EventHandler[]>();

  on(eventType: EventType, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  /**
   * Dispatch to every handler.
   *
   * One failing handler must not stop the others, and must not fail the whole
   * event — otherwise a bug in the reporting projection would block housekeeping
   * from ever seeing a check-in. We log and carry on; the relay decides whether
   * to retry the event as a whole.
   */
  async publish(event: PublishedEvent): Promise<{ failed: number }> {
    const handlers = this.handlers.get(event.eventType) ?? [];
    let failed = 0;

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        failed += 1;
        this.logger.error(
          `Handler failed for ${event.eventType} (${event.id}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { failed };
  }

  handlerCount(eventType: EventType): number {
    return this.handlers.get(eventType)?.length ?? 0;
  }
}
