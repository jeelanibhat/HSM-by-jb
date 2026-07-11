import { Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ROOM_STATUSES, type RoomStatus } from '@hotelos/domain';

export const RoomStatusEnum = Object.fromEntries(
  ROOM_STATUSES.map((s) => [s, s]),
) as Record<RoomStatus, RoomStatus>;

registerEnumType(RoomStatusEnum, {
  name: 'RoomStatus',
  description: 'VACANT_CLEAN | VACANT_DIRTY | OCCUPIED | OOO (out of order) | OOS (out of service)',
});

@ObjectType()
export class RoomTypeGql {
  @Field(() => ID) id!: string;
  @Field() code!: string;
  @Field() name!: string;
  @Field(() => Int) baseOccupancy!: number;
  @Field(() => Int) maxOccupancy!: number;
  @Field({ nullable: true }) description?: string;
}

@ObjectType()
export class RoomGql {
  @Field(() => ID) id!: string;
  @Field(() => ID) roomTypeId!: string;
  @Field() number!: string;
  @Field({ nullable: true }) floor?: string;
  @Field(() => RoomStatusEnum) status!: RoomStatus;
  @Field({ nullable: true }) statusNote?: string;

  /**
   * The statuses a human may move this room to right now. The UI renders exactly
   * these — so an occupied room simply has no "out of order" option to click,
   * rather than offering one and rejecting it.
   */
  @Field(() => [RoomStatusEnum])
  allowedTransitions!: RoomStatus[];
}

@ObjectType()
export class RatePlanGql {
  @Field(() => ID) id!: string;
  @Field() code!: string;
  @Field() name!: string;
  @Field() currency!: string;
  @Field() mealPlan!: string;
  @Field({ nullable: true }) description?: string;
}

@ObjectType()
export class RatePriceGql {
  @Field(() => ID) id!: string;
  @Field(() => ID) ratePlanId!: string;
  @Field(() => ID) roomTypeId!: string;
  @Field() date!: string;

  /** Minor units — paise/cents. The client formats; it never does arithmetic. */
  @Field(() => Int) priceMinor!: number;
}

@InputType()
export class CreateRoomTypeGqlInput {
  @Field() code!: string;
  @Field() name!: string;
  @Field(() => Int) baseOccupancy!: number;
  @Field(() => Int) maxOccupancy!: number;
  @Field({ nullable: true }) description?: string;
}

@InputType()
export class CreateRoomGqlInput {
  @Field(() => ID) roomTypeId!: string;
  @Field() number!: string;
  @Field({ nullable: true }) floor?: string;
}

@InputType()
export class CreateRatePlanGqlInput {
  @Field() code!: string;
  @Field() name!: string;
  @Field() currency!: string;
  @Field({ defaultValue: 'EP' }) mealPlan!: string;
  @Field({ nullable: true }) description?: string;
}

@InputType()
export class SetRatePricesGqlInput {
  @Field(() => ID) ratePlanId!: string;
  @Field(() => ID) roomTypeId!: string;
  @Field() from!: string;
  @Field() to!: string;
  @Field(() => Int) priceMinor!: number;
}

@InputType()
export class UpdateRoomStatusGqlInput {
  @Field(() => ID) roomId!: string;
  @Field(() => RoomStatusEnum) status!: RoomStatus;
  @Field({ nullable: true }) reason?: string;
}
