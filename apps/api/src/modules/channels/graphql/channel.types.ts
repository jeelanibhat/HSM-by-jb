import { Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  CHANNEL_DELIVERY_STATUSES,
  CHANNEL_OUTBOUND_STATUSES,
  type ChannelDeliveryStatus,
  type ChannelOutboundStatus,
} from '@hotelos/domain';

export const ChannelOutboundStatusEnum = Object.fromEntries(
  CHANNEL_OUTBOUND_STATUSES.map((s) => [s, s]),
) as Record<ChannelOutboundStatus, ChannelOutboundStatus>;

registerEnumType(ChannelOutboundStatusEnum, {
  name: 'ChannelOutboundStatus',
  description: 'PENDING | SENT | FAILED — the state of one availability push',
});

export const ChannelDeliveryStatusEnum = Object.fromEntries(
  CHANNEL_DELIVERY_STATUSES.map((s) => [s, s]),
) as Record<ChannelDeliveryStatus, ChannelDeliveryStatus>;

registerEnumType(ChannelDeliveryStatusEnum, {
  name: 'ChannelDeliveryStatus',
  description: 'RECEIVED | CONFIRMED | REJECTED | DUPLICATE — the fate of an inbound booking',
});

@ObjectType()
export class ChannelRoomTypeMappingGql {
  @Field(() => ID) roomTypeId!: string;
  @Field() externalRoomCode!: string;
}

@ObjectType()
export class ChannelRatePlanMappingGql {
  @Field(() => ID) ratePlanId!: string;
  @Field() externalRateCode!: string;
}

@ObjectType()
export class ChannelGql {
  @Field(() => ID) id!: string;
  @Field() code!: string;
  @Field() name!: string;
  @Field() enabled!: boolean;
  @Field(() => [ChannelRoomTypeMappingGql]) roomTypeMappings!: ChannelRoomTypeMappingGql[];
  @Field(() => [ChannelRatePlanMappingGql]) ratePlanMappings!: ChannelRatePlanMappingGql[];
}

/** One row of the inbound delivery log. */
@ObjectType()
export class ChannelBookingGql {
  @Field(() => ID) id!: string;
  @Field(() => ID) channelId!: string;
  @Field() externalRef!: string;
  @Field(() => ChannelDeliveryStatusEnum) status!: ChannelDeliveryStatus;
  @Field(() => ID, { nullable: true }) reservationId?: string | undefined;
  @Field(() => String, { nullable: true }) reason?: string | undefined;
  @Field(() => Date) createdAt!: Date;
}

/** One row of the outbound push log. */
@ObjectType()
export class ChannelSyncRowGql {
  @Field(() => ID) id!: string;
  @Field(() => ID) channelId!: string;
  @Field(() => ID) roomTypeId!: string;
  @Field() fromDate!: string;
  @Field() toDate!: string;
  @Field(() => ChannelOutboundStatusEnum) status!: ChannelOutboundStatus;
  @Field(() => Int) attempts!: number;
  @Field(() => String, { nullable: true }) lastError?: string | undefined;
  @Field(() => Date) createdAt!: Date;
  @Field(() => Date, { nullable: true }) sentAt?: Date | undefined;
}

/**
 * What the simulated channel currently believes.
 *
 * This is the simulator's read side — proof, for the UI and the tests, that a push
 * actually landed. A real OTA holds this state on its own servers; there is nothing to
 * read back here, which is why it is explicitly the *simulated* availability.
 */
@ObjectType()
export class SimulatedAriGql {
  @Field() externalRoomCode!: string;
  @Field(() => String, { nullable: true }) externalRateCode?: string | undefined;
  @Field() date!: string;
  @Field(() => Int) available!: number;
  @Field(() => Int, { nullable: true }) priceMinor?: number | undefined;
}

/** The outcome of feeding one inbound booking through ingestion. */
@ObjectType()
export class ChannelBookingResultGql {
  @Field(() => ChannelDeliveryStatusEnum) outcome!: ChannelDeliveryStatus;
  @Field(() => ID) bookingId!: string;
  @Field() externalRef!: string;
  @Field(() => ID, { nullable: true }) reservationId?: string | undefined;
  @Field(() => String, { nullable: true }) confirmationNo?: string | undefined;
  @Field(() => String, { nullable: true }) reason?: string | undefined;
}

@ObjectType()
export class ResyncResultGql {
  @Field(() => Int) queued!: number;
}

// ── Inputs ────────────────────────────────────────────────────────────────────

@InputType()
export class ConnectChannelGqlInput {
  @Field() code!: string;
  @Field() name!: string;
}

@InputType()
export class SetChannelEnabledGqlInput {
  @Field(() => ID) channelId!: string;
  @Field() enabled!: boolean;
}

@InputType()
export class MapChannelRoomTypeGqlInput {
  @Field(() => ID) channelId!: string;
  @Field(() => ID) roomTypeId!: string;
  @Field() externalRoomCode!: string;
}

@InputType()
export class MapChannelRatePlanGqlInput {
  @Field(() => ID) channelId!: string;
  @Field(() => ID) ratePlanId!: string;
  @Field() externalRateCode!: string;
}

@InputType()
export class ResyncChannelGqlInput {
  @Field(() => ID) channelId!: string;
}

@InputType()
export class SimulateChannelBookingGqlInput {
  @Field(() => ID) channelId!: string;
  @Field() externalRef!: string;
  @Field() externalRoomCode!: string;
  @Field() externalRateCode!: string;
  @Field() firstName!: string;
  @Field() lastName!: string;
  @Field(() => String, { nullable: true }) email?: string;
  @Field() arrivalDate!: string;
  @Field() departureDate!: string;
  @Field(() => Int) adults!: number;
  @Field(() => Int) children!: number;
}
