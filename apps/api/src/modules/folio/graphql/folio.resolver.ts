import { BadRequestException } from '@nestjs/common';
import {
  Args,
  Field,
  ID,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { postChargeSchema, postPaymentSchema, voidLineSchema } from '@hotelos/domain';
import type { z, ZodTypeAny } from 'zod';
import { CurrentUser, PropertyId, Roles } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { FolioService } from '../application/folio.service';

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

@ObjectType()
export class FolioLineGql {
  @Field(() => ID) id!: string;
  @Field() businessDate!: string;
  @Field() type!: string;
  @Field() code!: string;
  @Field() description!: string;

  /** Signed minor units. Positive = the guest owes more. */
  @Field(() => Int) amountMinor!: number;
  @Field(() => Int) taxAmountMinor!: number;
  @Field() currency!: string;

  /** True if a later line reverses this one. The UI strikes it through — it does
   *  NOT hide it, because it happened. */
  @Field() voided!: boolean;

  @Field(() => ID, { nullable: true }) reversesLineId?: string;
  @Field({ nullable: true }) reason?: string;
}

@ObjectType()
export class FolioGql {
  @Field(() => ID) id!: string;
  @Field() folioNo!: string;
  @Field() status!: string;
  @Field() type!: string;
  @Field() currency!: string;
  @Field(() => ID, { nullable: true }) reservationId?: string;
  @Field(() => ID) guestId!: string;

  /** What the guest still owes. Zero means they can check out. */
  @Field(() => Int) balanceMinor!: number;

  @Field(() => [FolioLineGql]) lines!: FolioLineGql[];
}

@ObjectType()
export class FolioBalanceGql {
  @Field(() => Int) charges!: number;
  @Field(() => Int) payments!: number;
  @Field(() => Int) tax!: number;
  @Field(() => Int) balance!: number;
  @Field() currency!: string;
}

@ObjectType()
export class InvoiceGql {
  @Field(() => ID) id!: string;
  @Field() invoiceNo!: string;
  @Field(() => ID) folioId!: string;
  @Field() issuedAt!: string;
}

@InputType()
export class PostChargeGqlInput {
  @Field(() => ID) folioId!: string;
  @Field() code!: string;
  @Field() description!: string;
  @Field(() => Int) amountMinor!: number;
  @Field(() => Int, { defaultValue: 1 }) quantity!: number;
  @Field() currency!: string;
}

@InputType()
export class PostPaymentGqlInput {
  @Field(() => ID) folioId!: string;
  @Field() code!: string;
  @Field(() => Int) amountMinor!: number;
  @Field() currency!: string;
  @Field({ nullable: true }) reference?: string;
}

@InputType()
export class VoidLineGqlInput {
  @Field(() => ID) folioLineId!: string;
  /** Required — a void moves money and the audit log wants to know why (§7.4). */
  @Field() reason!: string;
}

/**
 * Cashiering. HOUSEKEEPING is absent by design — this is the endpoint E2E case 6
 * points at: "RBAC: housekeeping role cannot access cashiering".
 */
@Resolver()
export class FolioResolver {
  constructor(private readonly folio: FolioService) {}

  /**
   * Fetch by folio id, or by the reservation it belongs to — the front desk almost
   * always has the latter, having just pulled up the guest's stay.
   */
  @Query(() => FolioGql, { nullable: true, name: 'folio' })
  async folio_(
    @PropertyId() propertyId: string,
    @Args('id', { type: () => ID, nullable: true }) id?: string,
    @Args('reservationId', { type: () => ID, nullable: true }) reservationId?: string,
  ): Promise<FolioGql | null> {
    if (id) return (await this.folio.getFolio(propertyId, id)) as unknown as FolioGql | null;

    if (!reservationId) throw new BadRequestException('Provide a folio id or a reservationId.');

    const found = await this.folio.findByReservation(propertyId, reservationId);
    if (!found) return null;

    return (await this.folio.getFolio(propertyId, found.id)) as unknown as FolioGql | null;
  }

  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => FolioBalanceGql)
  async postCharge(
    @Args('input') input: PostChargeGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FolioBalanceGql> {
    const data = parse(postChargeSchema, input);

    return this.folio.postCharge({ propertyId, userId: user.id }, {
      folioId: data.folioId,
      code: data.code,
      description: data.description,
      amountMinor: data.amountMinor,
      quantity: data.quantity,
    });
  }

  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => FolioBalanceGql)
  async postPayment(
    @Args('input') input: PostPaymentGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FolioBalanceGql> {
    const data = parse(postPaymentSchema, input);

    return this.folio.postPayment({ propertyId, userId: user.id }, {
      folioId: data.folioId,
      code: data.code,
      amountMinor: data.amountMinor,
      reference: data.reference,
    });
  }

  /**
   * Voiding money is a manager's call. A front desk agent who mis-keys a charge
   * asks someone to reverse it — that friction is the control.
   */
  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => FolioBalanceGql)
  async voidFolioLine(
    @Args('input') input: VoidLineGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<FolioBalanceGql> {
    const data = parse(voidLineSchema, input);

    return this.folio.voidLine({ propertyId, userId: user.id }, data.folioLineId, data.reason);
  }

  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK')
  @Mutation(() => InvoiceGql)
  async issueInvoice(
    @Args('folioId', { type: () => ID }) folioId: string,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InvoiceGql> {
    return (await this.folio.issueInvoice(
      { propertyId, userId: user.id },
      folioId,
    )) as unknown as InvoiceGql;
  }
}
