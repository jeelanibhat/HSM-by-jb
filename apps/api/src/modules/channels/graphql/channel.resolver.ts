import { BadRequestException } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  connectChannelSchema,
  mapChannelRatePlanSchema,
  mapChannelRoomTypeSchema,
  resyncChannelSchema,
  setChannelEnabledSchema,
  simulateChannelBookingSchema,
} from '@hotelos/domain';
import type { z, ZodTypeAny } from 'zod';
import { CurrentUser, PropertyId, Roles } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { ChannelConfigService } from '../application/channel-config.service';
import { ChannelInboundService } from '../application/channel-inbound.service';
import { SimulatedOtaConnector } from '../application/connector';
import {
  ChannelBookingGql,
  ChannelBookingResultGql,
  ChannelGql,
  ChannelSyncRowGql,
  ConnectChannelGqlInput,
  MapChannelRatePlanGqlInput,
  MapChannelRoomTypeGqlInput,
  ResyncChannelGqlInput,
  ResyncResultGql,
  SetChannelEnabledGqlInput,
  SimulateChannelBookingGqlInput,
  SimulatedAriGql,
} from './channel.types';

function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new BadRequestException(
      issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid input',
    );
  }
  return result.data;
}

/**
 * Who runs the channel manager: management only.
 *
 * Connecting an OTA, mapping rooms, and switching a channel on decide what the hotel
 * sells and at what price on the open market — that is a manager's call, not a
 * receptionist's, and certainly not a waiter's. There is no read-only view for other
 * roles here: the front desk sees an OTA booking as an ordinary reservation on its board,
 * which is exactly where it belongs.
 */
const MANAGERS = ['ADMIN', 'MANAGER'] as const;

@Resolver()
export class ChannelResolver {
  constructor(
    private readonly config: ChannelConfigService,
    private readonly inbound: ChannelInboundService,
    private readonly connector: SimulatedOtaConnector,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  @Roles(...MANAGERS)
  @Query(() => [ChannelGql])
  async channels(@PropertyId() propertyId: string): Promise<ChannelGql[]> {
    return (await this.config.listChannels(propertyId)) as unknown as ChannelGql[];
  }

  @Roles(...MANAGERS)
  @Query(() => [ChannelBookingGql])
  async channelBookings(
    @PropertyId() propertyId: string,
    @Args('channelId', { type: () => ID, nullable: true }) channelId?: string,
  ): Promise<ChannelBookingGql[]> {
    return (await this.config.listBookings(propertyId, channelId)) as unknown as ChannelBookingGql[];
  }

  @Roles(...MANAGERS)
  @Query(() => [ChannelSyncRowGql])
  async channelSyncLog(
    @PropertyId() propertyId: string,
    @Args('channelId', { type: () => ID, nullable: true }) channelId?: string,
  ): Promise<ChannelSyncRowGql[]> {
    return (await this.config.listSyncLog(propertyId, channelId)) as unknown as ChannelSyncRowGql[];
  }

  /**
   * What the simulated channel currently believes about our availability.
   *
   * The channel is loaded through the tenant-scoped config service FIRST, so a manager
   * cannot read back another property's pushed availability by naming its channel id —
   * the simulator's memory is keyed by channel alone and would otherwise leak across
   * tenants.
   */
  @Roles(...MANAGERS)
  @Query(() => [SimulatedAriGql])
  async simulatedAri(
    @PropertyId() propertyId: string,
    @Args('channelId', { type: () => ID }) channelId: string,
  ): Promise<SimulatedAriGql[]> {
    await this.config.getChannel(propertyId, channelId); // throws if not this property's

    return this.connector.currentAri(channelId).map((u) => ({
      externalRoomCode: u.externalRoomCode,
      externalRateCode: u.externalRateCode ?? undefined,
      date: u.date,
      available: u.available,
      priceMinor: u.priceMinor ?? undefined,
    }));
  }

  // ── Config mutations ─────────────────────────────────────────────────────────

  @Roles(...MANAGERS)
  @Mutation(() => ChannelGql)
  async connectChannel(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: ConnectChannelGqlInput,
  ): Promise<ChannelGql> {
    const dto = parse(connectChannelSchema, input);
    return (await this.config.connect({ propertyId, userId: user.id }, dto)) as unknown as ChannelGql;
  }

  @Roles(...MANAGERS)
  @Mutation(() => ChannelGql)
  async setChannelEnabled(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: SetChannelEnabledGqlInput,
  ): Promise<ChannelGql> {
    const dto = parse(setChannelEnabledSchema, input);
    return (await this.config.setEnabled({ propertyId, userId: user.id }, dto)) as unknown as ChannelGql;
  }

  @Roles(...MANAGERS)
  @Mutation(() => ChannelGql)
  async mapChannelRoomType(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: MapChannelRoomTypeGqlInput,
  ): Promise<ChannelGql> {
    const dto = parse(mapChannelRoomTypeSchema, input);
    return (await this.config.mapRoomType({ propertyId, userId: user.id }, dto)) as unknown as ChannelGql;
  }

  @Roles(...MANAGERS)
  @Mutation(() => ChannelGql)
  async mapChannelRatePlan(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: MapChannelRatePlanGqlInput,
  ): Promise<ChannelGql> {
    const dto = parse(mapChannelRatePlanSchema, input);
    return (await this.config.mapRatePlan({ propertyId, userId: user.id }, dto)) as unknown as ChannelGql;
  }

  @Roles(...MANAGERS)
  @Mutation(() => ResyncResultGql)
  async resyncChannel(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: ResyncChannelGqlInput,
  ): Promise<ResyncResultGql> {
    const dto = parse(resyncChannelSchema, input);
    return this.config.resync({ propertyId, userId: user.id }, dto);
  }

  /**
   * Feed one booking in as if an OTA had delivered it.
   *
   * This is the inbound seam. A real connector receives bookings over the wire; the
   * simulated one is fed here, which is also exactly what the tests and the demo drive.
   */
  @Roles(...MANAGERS)
  @Mutation(() => ChannelBookingResultGql)
  async simulateChannelBooking(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: SimulateChannelBookingGqlInput,
  ): Promise<ChannelBookingResultGql> {
    const dto = parse(simulateChannelBookingSchema, {
      channelId: input.channelId,
      externalRef: input.externalRef,
      externalRoomCode: input.externalRoomCode,
      externalRateCode: input.externalRateCode,
      guest: {
        firstName: input.firstName,
        lastName: input.lastName,
        ...(input.email !== undefined ? { email: input.email } : {}),
      },
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
      adults: input.adults,
      children: input.children,
    });

    const result = await this.inbound.ingest(
      { propertyId, userId: user.id },
      {
        channelId: dto.channelId,
        externalRef: dto.externalRef,
        externalRoomCode: dto.externalRoomCode,
        externalRateCode: dto.externalRateCode,
        guest: dto.guest,
        arrivalDate: dto.arrivalDate,
        departureDate: dto.departureDate,
        adults: dto.adults,
        children: dto.children,
      },
    );

    return {
      outcome: result.outcome,
      bookingId: result.bookingId,
      externalRef: result.externalRef,
      reservationId: result.reservationId,
      confirmationNo: result.confirmationNo,
      reason: result.reason,
    };
  }
}
