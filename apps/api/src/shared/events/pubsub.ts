import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisPubSub } from 'graphql-redis-subscriptions';
import Redis from 'ioredis';
import type { Env } from '../../config/env';
import { EventBus } from './event-bus';
import type { PublishedEvent } from './domain-event';

export const PUB_SUB = Symbol('PUB_SUB');

/**
 * GraphQL subscription fan-out (TDD §5, §10).
 *
 * Backed by Valkey rather than an in-memory emitter because subscriptions must
 * survive horizontal scaling: with N API replicas, a room-status change handled
 * by pod 1 has to reach the front-desk browser holding a socket to pod 3. An
 * in-process PubSub would silently only notify whoever happened to be connected
 * to the pod that did the write — which works perfectly on one machine and fails
 * the moment you add a second.
 */
export const pubSubProvider = {
  provide: PUB_SUB,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => {
    const url = config.get('VALKEY_URL', { infer: true });

    // Separate connections: a Redis/Valkey client in subscribe mode cannot issue
    // ordinary commands, so publisher and subscriber must not share one socket.
    return new RedisPubSub({
      publisher: new Redis(url),
      subscriber: new Redis(url),
    });
  },
};

/** Topic names. Kept here so the resolver and the bridge cannot disagree. */
export const TOPIC = {
  roomStatusChanged: (propertyId: string) => `room.status_changed:${propertyId}`,
  tapeChartChanged: (propertyId: string) => `tape_chart.changed:${propertyId}`,
} as const;

/**
 * Bridges committed domain events onto the subscription topics.
 *
 * Subscribers are fed from the OUTBOX RELAY, never from the use-case directly.
 * That means a browser can only ever be told about a change that actually
 * committed — no flicker of a reservation that rolled back a millisecond later.
 * The cost is latency (one relay tick), and it is worth it.
 */
@Injectable()
export class EventPubSubBridge implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    @Inject(PUB_SUB) private readonly pubSub: RedisPubSub,
  ) {}

  onModuleInit(): void {
    this.bus.on('room.status_changed', (event) => this.onRoomStatus(event));

    // Anything that moves a block on the grid redraws the chart.
    for (const type of [
      'reservation.created',
      'reservation.modified',
      'reservation.cancelled',
      'reservation.checked_in',
      'reservation.checked_out',
      'reservation.no_show',
    ] as const) {
      this.bus.on(type, (event) => this.onTapeChartChange(event));
    }
  }

  private async onRoomStatus(event: PublishedEvent): Promise<void> {
    if (!event.propertyId) return;

    await this.pubSub.publish(TOPIC.roomStatusChanged(event.propertyId), {
      roomStatusChanged: {
        roomId: String(event.payload['roomId'] ?? event.aggregateId),
        number: String(event.payload['number'] ?? ''),
        status: String(event.payload['to'] ?? ''),
      },
    });

    // A room going OOO changes what the chart can sell, so it redraws too.
    await this.onTapeChartChange(event);
  }

  private async onTapeChartChange(event: PublishedEvent): Promise<void> {
    if (!event.propertyId) return;

    /**
     * The delta carries only "something changed, and roughly what" — the client
     * refetches the affected window rather than trying to patch its cache from a
     * partial payload. Patching is where two screens quietly diverge, and a tape
     * chart that disagrees with the database is worse than one that is a second
     * out of date.
     */
    await this.pubSub.publish(TOPIC.tapeChartChanged(event.propertyId), {
      tapeChartChanged: {
        eventType: event.eventType,
        reservationId: event.aggregateId,
        occurredAt: event.occurredAt.toISOString(),
      },
    });
  }
}
