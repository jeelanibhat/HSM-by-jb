import { Args, Field, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { PropertyId } from '../../identity';
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

  @Field(() => ID, { nullable: true }) folioId?: string;
  /** Check-out is refused unless this is zero. The list shows it so nobody is surprised. */
  @Field(() => Int) balanceMinor!: number;
}

@ObjectType()
export class FrontDeskBoardGql {
  @Field() businessDate!: string;
  @Field(() => [FrontDeskRowGql]) arrivals!: FrontDeskRowGql[];
  @Field(() => [FrontDeskRowGql]) departures!: FrontDeskRowGql[];
  @Field(() => [FrontDeskRowGql]) inHouse!: FrontDeskRowGql[];
}

@Resolver()
export class FrontDeskResolver {
  constructor(private readonly frontDesk: FrontDeskService) {}

  /**
   * No @Roles(): housekeeping needs to see who is arriving and leaving as much as
   * the front desk does. The guards above have already established identity and
   * property access, and this list carries no money and no PII beyond a name.
   */
  @Query(() => FrontDeskBoardGql)
  async frontDeskBoard(
    @PropertyId() propertyId: string,
    @Args('date') date: string,
  ): Promise<FrontDeskBoardGql> {
    return (await this.frontDesk.board(propertyId, date)) as unknown as FrontDeskBoardGql;
  }
}
