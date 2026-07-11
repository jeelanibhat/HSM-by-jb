import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class TapeChartRoomGql {
  @Field(() => ID) id!: string;
  @Field() number!: string;
  @Field({ nullable: true }) floor?: string;
  @Field() status!: string;
  @Field(() => ID) roomTypeId!: string;
  @Field() roomTypeCode!: string;
}

@ObjectType()
export class TapeChartBlockGql {
  @Field(() => ID) reservationRoomId!: string;
  @Field(() => ID) reservationId!: string;
  @Field(() => ID) roomId!: string;
  @Field() confirmationNo!: string;
  @Field() guestName!: string;
  @Field() status!: string;
  @Field() arrivalDate!: string;
  @Field() departureDate!: string;
}

@ObjectType()
export class UnassignedBlockGql {
  @Field(() => ID) reservationRoomId!: string;
  @Field(() => ID) reservationId!: string;
  @Field() confirmationNo!: string;
  @Field() guestName!: string;
  @Field() status!: string;
  @Field(() => ID) roomTypeId!: string;
  @Field() roomTypeCode!: string;
  @Field() arrivalDate!: string;
  @Field() departureDate!: string;
}

@ObjectType()
export class TapeChartGql {
  @Field() from!: string;
  @Field() to!: string;
  @Field(() => [String]) dates!: string[];
  @Field(() => [TapeChartRoomGql]) rooms!: TapeChartRoomGql[];
  @Field(() => [TapeChartBlockGql]) blocks!: TapeChartBlockGql[];
  /** Booked but not yet given a room — the front desk's work list. */
  @Field(() => [UnassignedBlockGql]) unassigned!: UnassignedBlockGql[];
}

@ObjectType()
export class RoomStatusChangedGql {
  @Field(() => ID) roomId!: string;
  @Field() number!: string;
  @Field() status!: string;
}

/**
 * A nudge, not a patch. It says "something moved", and the client refetches the
 * window it is looking at. Sending a partial payload for the client to splice
 * into its cache is how two screens quietly drift apart — and a tape chart that
 * disagrees with the database is worse than one that is a second stale.
 */
@ObjectType()
export class TapeChartChangedGql {
  @Field() eventType!: string;
  @Field(() => ID) reservationId!: string;
  @Field() occurredAt!: string;
}
