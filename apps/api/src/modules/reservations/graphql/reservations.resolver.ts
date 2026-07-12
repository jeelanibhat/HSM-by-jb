import { BadRequestException } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  cancelReservationSchema,
  createReservationSchema,
  stayDatesSchema,
  type ReservationStatus,
} from '@hotelos/domain';
import type { z, ZodTypeAny } from 'zod';
import { CurrentUser, PropertyId, Roles } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { ReservationsService } from '../application/reservations.service';
import { StayService } from '../application/stay.service';
import {
  AssignRoomGqlInput,
  AvailabilityGql,
  CancelReservationGqlInput,
  CheckInPayloadGql,
  CreateReservationGqlInput,
  ModifyReservationGqlInput,
  ReservationGql,
  ReservationRoomGql,
  ReservationStatusEnum,
} from './reservations.types';

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

@Resolver()
export class ReservationsResolver {
  constructor(
    private readonly service: ReservationsService,
    private readonly stay: StayService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────────────

  @Query(() => [AvailabilityGql])
  async availability(
    @PropertyId() propertyId: string,
    @Args('from') from: string,
    @Args('to') to: string,
    @Args('roomTypeId', { type: () => ID, nullable: true }) roomTypeId?: string,
  ): Promise<AvailabilityGql[]> {
    return this.service.availabilityGrid(propertyId, from, to, roomTypeId);
  }

  @Query(() => ReservationGql, { nullable: true })
  async reservation(
    @PropertyId() propertyId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<ReservationGql | null> {
    return (await this.service.findById(propertyId, id)) as ReservationGql | null;
  }

  @Query(() => [ReservationGql])
  async reservations(
    @PropertyId() propertyId: string,
    @Args('status', { type: () => ReservationStatusEnum, nullable: true })
    status?: ReservationStatus,
  ): Promise<ReservationGql[]> {
    return (await this.service.list(propertyId, status)) as ReservationGql[];
  }

  @Query(() => [ReservationGql])
  async arrivals(
    @PropertyId() propertyId: string,
    @Args('date') date: string,
  ): Promise<ReservationGql[]> {
    return (await this.service.arrivals(propertyId, date)) as ReservationGql[];
  }

  @Query(() => [ReservationGql])
  async departures(
    @PropertyId() propertyId: string,
    @Args('date') date: string,
  ): Promise<ReservationGql[]> {
    return (await this.service.departures(propertyId, date)) as ReservationGql[];
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  // Taking a booking is the front desk's core job. HOUSEKEEPING and AUDITOR are
  // deliberately absent — neither sells rooms.

  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => ReservationGql)
  async createReservation(
    @Args('input') input: CreateReservationGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationGql> {
    const data = parse(createReservationSchema, input);
    return (await this.service.create({ propertyId, userId: user.id }, data)) as ReservationGql;
  }

  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => ReservationGql)
  async cancelReservation(
    @Args('input') input: CancelReservationGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationGql> {
    const data = parse(cancelReservationSchema, input);
    return (await this.service.cancel(
      { propertyId, userId: user.id },
      data.reservationId,
      data.reason,
    )) as ReservationGql;
  }

  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => ReservationGql)
  async modifyReservation(
    @Args('input') input: ModifyReservationGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationGql> {
    const dates = parse(stayDatesSchema, {
      arrivalDate: input.arrivalDate,
      departureDate: input.departureDate,
    });

    return (await this.service.modifyDates(
      { propertyId, userId: user.id },
      input.reservationId,
      dates.arrivalDate,
      dates.departureDate,
    )) as ReservationGql;
  }

  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => ReservationRoomGql)
  async assignRoom(
    @Args('input') input: AssignRoomGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReservationRoomGql> {
    return (await this.service.assignRoom(
      { propertyId, userId: user.id },
      input.reservationRoomId,
      input.roomId,
    )) as ReservationRoomGql;
  }

  // ── Check-in / check-out (TDD step 8) ─────────────────────────────────────

  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => CheckInPayloadGql)
  async checkIn(
    @Args('reservationId', { type: () => ID }) reservationId: string,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CheckInPayloadGql> {
    const result = await this.stay.checkIn({ propertyId, userId: user.id }, reservationId);

    return {
      reservation: result.reservation as unknown as ReservationGql,
      folioId: result.folioId,
    };
  }

  /** Fails if the folio is not settled — see FolioService.assertSettled (TDD §6). */
  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => CheckInPayloadGql)
  async checkOut(
    @Args('reservationId', { type: () => ID }) reservationId: string,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CheckInPayloadGql> {
    const result = await this.stay.checkOut({ propertyId, userId: user.id }, reservationId);

    return {
      reservation: result.reservation as unknown as ReservationGql,
      folioId: result.folioId,
    };
  }
}
