import { ForbiddenException, Inject } from '@nestjs/common';
import { Args, ID, Query, Resolver, Subscription } from '@nestjs/graphql';
import type { RedisPubSub } from 'graphql-redis-subscriptions';
import { PropertyId, Public } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { PUB_SUB, TOPIC } from '../../../shared';
import { TapeChartService } from '../application/tape-chart.service';
import {
  RoomStatusChangedGql,
  TapeChartChangedGql,
  TapeChartGql,
} from './tape-chart.types';

@Resolver()
export class TapeChartResolver {
  constructor(
    // Named `service`, not `tapeChart`: the resolver METHOD is `tapeChart` (the
    // GraphQL field name), and a field and a method cannot share a name.
    private readonly service: TapeChartService,
    @Inject(PUB_SUB) private readonly pubSub: RedisPubSub,
  ) {}

  @Query(() => TapeChartGql)
  async tapeChart(
    @PropertyId() propertyId: string,
    @Args('from') from: string,
    @Args('to') to: string,
  ): Promise<TapeChartGql> {
    return (await this.service.get(propertyId, from, to)) as TapeChartGql;
  }

  /**
   * Subscriptions bypass the HTTP guards entirely — there is no request to hang
   * them off. Authentication happened once at the WebSocket handshake (see
   * `subscriptions` in app.module), and the authenticated user is on the
   * connection context.
   *
   * So the propertyId argument MUST be re-checked here against that user's role
   * claims. Without this, any authenticated user could subscribe to any hotel's
   * live feed simply by passing its id — the tenancy check we do so carefully on
   * every HTTP request would have a WebSocket-shaped hole in it.
   */
  @Public() // guards do not run for WS; the check below replaces them
  @Subscription(() => RoomStatusChangedGql, {
    filter: (_payload, variables, context) =>
      assertMayWatch(context, variables.propertyId as string),
  })
  roomStatusChanged(@Args('propertyId', { type: () => ID }) propertyId: string) {
    return this.pubSub.asyncIterator(TOPIC.roomStatusChanged(propertyId));
  }

  @Public()
  @Subscription(() => TapeChartChangedGql, {
    filter: (_payload, variables, context) =>
      assertMayWatch(context, variables.propertyId as string),
  })
  tapeChartChanged(@Args('propertyId', { type: () => ID }) propertyId: string) {
    return this.pubSub.asyncIterator(TOPIC.tapeChartChanged(propertyId));
  }
}

/**
 * Does the user on this socket actually work at that property?
 *
 * Returning false silently drops the message rather than erroring — a subscriber
 * who is not entitled to a property's feed should simply never hear from it, and
 * a loud error would confirm the property exists.
 */
function assertMayWatch(context: unknown, propertyId: string): boolean {
  const user = (context as { user?: AuthenticatedUser } | undefined)?.user;
  if (!user) return false;

  return user.roles.some((r) => r.propertyId === propertyId);
}

/** Thrown at handshake time if the socket presents no valid token. */
export class UnauthenticatedSocketError extends ForbiddenException {
  constructor() {
    super('A valid access token is required to open a subscription.');
  }
}
