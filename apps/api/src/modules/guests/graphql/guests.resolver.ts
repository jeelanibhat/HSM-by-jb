import { BadRequestException } from '@nestjs/common';
import {
  Args,
  Field,
  ID,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { guestSchema } from '@hotelos/domain';
import { CurrentUser, PropertyId, Roles } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { GuestsService } from '../application/guests.service';
import type { GuestView } from '../application/guests.service';

@ObjectType()
export class GuestGql {
  @Field(() => ID) id!: string;
  @Field() firstName!: string;
  @Field() lastName!: string;
  @Field({ nullable: true }) email?: string;
  @Field({ nullable: true }) phone?: string;
  @Field({ nullable: true }) idType?: string;

  /**
   * Last four only — '••••4567'. There is deliberately no `idNumber` field on this
   * type: the schema itself makes the full value unreachable through an ordinary
   * query. It comes back only from revealIdNumber(), which audits the access.
   */
  @Field({ nullable: true }) idNumberMasked?: string;

  @Field() vip!: boolean;
  @Field() blacklisted!: boolean;
  @Field({ nullable: true }) anonymisedAt?: string;
}

@ObjectType()
export class StayGql {
  @Field(() => ID) reservationId!: string;
  @Field() confirmationNo!: string;
  @Field() status!: string;
  @Field() arrivalDate!: string;
  @Field() departureDate!: string;
}

@InputType()
export class CreateGuestGqlInput {
  @Field() firstName!: string;
  @Field() lastName!: string;
  @Field({ nullable: true }) email?: string;
  @Field({ nullable: true }) phone?: string;
  @Field({ nullable: true }) idType?: string;
  @Field({ nullable: true }) idNumber?: string;
  @Field({ nullable: true }) vip?: boolean;
}

@InputType()
export class RevealIdGqlInput {
  @Field(() => ID) guestId!: string;
  /** Required. It goes into the audit log next to the operator's name. */
  @Field() reason!: string;
}

@InputType()
export class AnonymiseGuestGqlInput {
  @Field(() => ID) guestId!: string;
  @Field() reason!: string;
}

@InputType()
export class BlacklistGuestGqlInput {
  @Field(() => ID) guestId!: string;
  @Field() blacklisted!: boolean;
  @Field() reason!: string;
}

/**
 * Explicit mapper, not a cast.
 *
 * A `as GuestGql` here would happily pass through any new field the service starts
 * returning — including, one day, a decrypted ID number that someone added to
 * GuestView "just for internal use". Listing the fields means the compiler is the
 * thing deciding what reaches a client, and adding a PII field to the view does
 * not silently publish it.
 */
function toGql(g: GuestView): GuestGql {
  return {
    id: g.id,
    firstName: g.firstName,
    lastName: g.lastName,
    email: g.email ?? undefined,
    phone: g.phone ?? undefined,
    idType: g.idType ?? undefined,
    idNumberMasked: g.idNumberMasked ?? undefined,
    vip: g.vip,
    blacklisted: g.blacklisted,
    anonymisedAt: g.anonymisedAt?.toISOString() ?? undefined,
  };
}

@Resolver()
export class GuestsResolver {
  constructor(private readonly guests: GuestsService) {}

  @Query(() => GuestGql, { nullable: true })
  async guest(
    @PropertyId() propertyId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<GuestGql | null> {
    const g = await this.guests.findById(propertyId, id);
    return g ? toGql(g) : null;
  }

  @Query(() => [GuestGql])
  async searchGuests(
    @PropertyId() propertyId: string,
    @Args('query') query: string,
  ): Promise<GuestGql[]> {
    return (await this.guests.search(propertyId, query)).map(toGql);
  }

  /** Exact match via the blind index. Returns the guest, never the number. */
  @Query(() => GuestGql, { nullable: true })
  async guestByIdNumber(
    @PropertyId() propertyId: string,
    @Args('idNumber') idNumber: string,
  ): Promise<GuestGql | null> {
    const g = await this.guests.findByIdNumber(propertyId, idNumber);
    return g ? toGql(g) : null;
  }

  @Query(() => [StayGql])
  async guestStays(
    @PropertyId() propertyId: string,
    @Args('guestId', { type: () => ID }) guestId: string,
  ): Promise<StayGql[]> {
    return (await this.guests.stayHistory(propertyId, guestId)) as StayGql[];
  }

  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => GuestGql)
  async createGuest(
    @Args('input') input: CreateGuestGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GuestGql> {
    const parsed = guestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid guest');
    }

    return toGql(await this.guests.create({ propertyId, userId: user.id }, input));
  }

  /**
   * The only route to a full ID number.
   *
   * Restricted to ADMIN and MANAGER: a receptionist verifying a guest at check-in
   * needs the last four (which they already have), not the whole passport number.
   * Every call is audited with the operator and their stated reason.
   */
  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => String)
  async revealIdNumber(
    @Args('input') input: RevealIdGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<string> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 3) {
      throw new BadRequestException('A reason is required to view a guest ID number.');
    }

    return this.guests.revealIdNumber({ propertyId, userId: user.id }, input.guestId, reason);
  }

  /** GDPR / DPDP erasure. Irreversible, so only an admin may do it. */
  @Roles('ADMIN')
  @Mutation(() => GuestGql)
  async anonymiseGuest(
    @Args('input') input: AnonymiseGuestGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GuestGql> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 3) {
      throw new BadRequestException('A reason is required to erase a guest.');
    }

    return toGql(
      await this.guests.anonymise({ propertyId, userId: user.id }, input.guestId, reason),
    );
  }

  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => GuestGql)
  async setGuestBlacklisted(
    @Args('input') input: BlacklistGuestGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GuestGql> {
    const reason = input.reason?.trim() ?? '';
    if (reason.length < 3) {
      throw new BadRequestException('A reason is required.');
    }

    return toGql(
      await this.guests.setBlacklisted(
        { propertyId, userId: user.id },
        input.guestId,
        input.blacklisted,
        reason,
      ),
    );
  }
}
