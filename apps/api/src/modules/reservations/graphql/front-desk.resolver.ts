import { Args, Field, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import type { Role } from '@hotelos/domain';
import { CurrentUser, PropertyId } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { FrontDeskService } from '../application/front-desk.service';

@ObjectType()
export class FrontDeskRowGql {
  @Field(() => ID) reservationId!: string;
  @Field(() => ID) reservationRoomId!: string;
  @Field() confirmationNo!: string;
  @Field(() => ID) guestId!: string;
  @Field() guestName!: string;
  @Field() vip!: boolean;
  @Field() status!: string;

  @Field(() => ID, { nullable: true }) roomId?: string;
  @Field({ nullable: true }) roomNumber?: string;
  /** The room-assignment picker needs it to offer only rooms of the booked type. */
  @Field(() => ID) roomTypeId!: string;
  @Field() roomTypeCode!: string;

  @Field() arrivalDate!: string;
  @Field() departureDate!: string;
  @Field(() => Int) adults!: number;
  @Field(() => Int) children!: number;

  /** NULL for roles that may not touch cashiering — see the resolver. */
  @Field(() => ID, { nullable: true }) folioId?: string;
  /** Check-out is refused unless this is zero. Zeroed for non-cashiering roles. */
  @Field(() => Int) balanceMinor!: number;
}

@ObjectType()
export class FrontDeskBoardGql {
  @Field() businessDate!: string;
  @Field(() => [FrontDeskRowGql]) arrivals!: FrontDeskRowGql[];
  @Field(() => [FrontDeskRowGql]) departures!: FrontDeskRowGql[];
  @Field(() => [FrontDeskRowGql]) inHouse!: FrontDeskRowGql[];
}

/** The roles whose job involves a guest's money. */
const CASHIERING: readonly Role[] = ['ADMIN', 'MANAGER', 'FRONT_DESK', 'AUDITOR'];

@Resolver()
export class FrontDeskResolver {
  constructor(private readonly frontDesk: FrontDeskService) {}

  /**
   * The arrivals / departures / in-house board.
   *
   * No @Roles(): housekeeping genuinely needs to know who is arriving and leaving —
   * that is how they plan the day's turnovers.
   *
   * But the board also carries a folio id and a balance, and a guest's bill is none of
   * housekeeping's business. So the MONEY is redacted here, server-side, rather than
   * hidden in the UI: a field the client is trusted to conceal is a field that leaks
   * the moment someone opens the network tab.
   */
  @Query(() => FrontDeskBoardGql)
  async frontDeskBoard(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('date') date: string,
  ): Promise<FrontDeskBoardGql> {
    const board = await this.frontDesk.board(propertyId, date);

    const role = user.roles.find((r) => r.propertyId === propertyId)?.role;
    const maySeeMoney = role !== undefined && CASHIERING.includes(role);

    if (maySeeMoney) return board as unknown as FrontDeskBoardGql;

    const redact = (rows: typeof board.arrivals) =>
      rows.map((r) => ({ ...r, folioId: null, balanceMinor: 0 }));

    return {
      ...board,
      arrivals: redact(board.arrivals),
      departures: redact(board.departures),
      inHouse: redact(board.inHouse),
    } as unknown as FrontDeskBoardGql;
  }
}
