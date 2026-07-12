import { Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  RESERVATION_SOURCES,
  RESERVATION_STATUSES,
  type ReservationSource,
  type ReservationStatus,
} from '@hotelos/domain';

export const ReservationStatusEnum = Object.fromEntries(
  RESERVATION_STATUSES.map((s) => [s, s]),
) as Record<ReservationStatus, ReservationStatus>;
registerEnumType(ReservationStatusEnum, { name: 'ReservationStatus' });

export const ReservationSourceEnum = Object.fromEntries(
  RESERVATION_SOURCES.map((s) => [s, s]),
) as Record<ReservationSource, ReservationSource>;
registerEnumType(ReservationSourceEnum, { name: 'ReservationSource' });

@ObjectType()
export class ReservationRoomGql {
  @Field(() => ID) id!: string;
  @Field(() => ID) roomTypeId!: string;
  @Field(() => ID, { nullable: true }) roomId?: string;
  @Field(() => ID) ratePlanId!: string;
  @Field() arrivalDate!: string;
  @Field() departureDate!: string;
  @Field(() => ReservationStatusEnum) status!: ReservationStatus;
  @Field(() => Int) adults!: number;
  @Field(() => Int) children!: number;
}

@ObjectType()
export class ReservationGql {
  @Field(() => ID) id!: string;
  @Field() confirmationNo!: string;
  @Field(() => ID) guestId!: string;
  @Field(() => ReservationStatusEnum) status!: ReservationStatus;
  @Field(() => ReservationSourceEnum) source!: ReservationSource;
  @Field() arrivalDate!: string;
  @Field() departureDate!: string;
  @Field(() => Int) adults!: number;
  @Field(() => Int) children!: number;
  @Field({ nullable: true }) notes?: string;
  @Field(() => [ReservationRoomGql], { nullable: true }) rooms?: ReservationRoomGql[];
}

/** One room type, one night. `available` is what the booking screen reads. */
@ObjectType()
export class AvailabilityGql {
  @Field(() => ID) roomTypeId!: string;
  @Field() date!: string;
  @Field(() => Int) total!: number;
  @Field(() => Int) sold!: number;
  @Field(() => Int) blocked!: number;
  @Field(() => Int) available!: number;
}

@InputType()
export class GuestInputGql {
  @Field() firstName!: string;
  @Field() lastName!: string;
  @Field({ nullable: true }) email?: string;
  @Field({ nullable: true }) phone?: string;
}

@InputType()
export class ReservationRoomInputGql {
  @Field(() => ID) roomTypeId!: string;
  @Field(() => ID) ratePlanId!: string;
  @Field(() => Int, { defaultValue: 1 }) adults!: number;
  @Field(() => Int, { defaultValue: 0 }) children!: number;
}

@InputType()
export class CreateReservationGqlInput {
  @Field(() => ID, { nullable: true }) guestId?: string;
  @Field(() => GuestInputGql, { nullable: true }) guest?: GuestInputGql;
  @Field(() => ReservationSourceEnum) source!: ReservationSource;
  @Field() arrivalDate!: string;
  @Field() departureDate!: string;
  @Field(() => [ReservationRoomInputGql]) rooms!: ReservationRoomInputGql[];
  @Field({ nullable: true }) notes?: string;
}

@InputType()
export class CancelReservationGqlInput {
  @Field(() => ID) reservationId!: string;
  /** Destructive op — a reason is required and lands in the audit log (§7.4). */
  @Field() reason!: string;
}

@InputType()
export class ModifyReservationGqlInput {
  @Field(() => ID) reservationId!: string;
  @Field() arrivalDate!: string;
  @Field() departureDate!: string;
}

@InputType()
export class AssignRoomGqlInput {
  @Field(() => ID) reservationRoomId!: string;
  @Field(() => ID) roomId!: string;
}

/** Check-in and check-out both hand back the folio — the clerk needs it next. */
@ObjectType()
export class CheckInPayloadGql {
  @Field(() => ReservationGql) reservation!: ReservationGql;
  @Field(() => ID) folioId!: string;
}
