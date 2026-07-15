import { Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { POS_ORDER_STATUSES, type PosOrderStatus } from '@hotelos/domain';

export const PosOrderStatusEnum = Object.fromEntries(
  POS_ORDER_STATUSES.map((s) => [s, s]),
) as Record<PosOrderStatus, PosOrderStatus>;

registerEnumType(PosOrderStatusEnum, {
  name: 'PosOrderStatus',
  description: 'OPEN | CHARGED (on the guest’s bill, immutable) | VOID',
});

@ObjectType()
export class OutletGql {
  @Field(() => ID) id!: string;
  @Field() code!: string;
  @Field() name!: string;
  @Field() chargeCode!: string;
}

@ObjectType()
export class MenuItemGql {
  @Field(() => ID) id!: string;
  @Field() code!: string;
  @Field() name!: string;
  @Field(() => String, { nullable: true }) category?: string | undefined;
  @Field(() => Int) priceMinor!: number;
}

@ObjectType()
export class OrderLineGql {
  @Field(() => ID) id!: string;
  @Field(() => ID) menuItemId!: string;

  /** The name and price AS SOLD. Not a live join to the menu — see the schema. */
  @Field() description!: string;
  @Field(() => Int) unitPriceMinor!: number;
  @Field(() => Int) quantity!: number;
  @Field(() => String, { nullable: true }) notes?: string | undefined;
}

@ObjectType()
export class PosOrderGql {
  @Field(() => ID) id!: string;
  @Field(() => ID) outletId!: string;
  @Field() orderNo!: string;
  @Field(() => PosOrderStatusEnum) status!: PosOrderStatus;
  @Field(() => String, { nullable: true }) tableRef?: string | undefined;
  @Field() businessDate!: string;

  @Field(() => [OrderLineGql]) lines!: OrderLineGql[];

  /**
   * Tax EXCLUDED. The tax is the folio's, computed at the moment of posting from the
   * property's configuration — the POS does not have its own opinion about GST.
   */
  @Field(() => Int) subtotalMinor!: number;

  /**
   * There is deliberately no `roomNumber` here. An order stores the room's ID, not its
   * number, so the field would have to be joined in — and every read of the board would
   * pay for a column only a charged order can have. ChargeResultGql carries the room
   * number back at the one moment a waiter needs to read it: the confirmation.
   */
  @Field(() => Date, { nullable: true }) chargedAt?: Date | undefined;
  @Field(() => String, { nullable: true }) voidReason?: string | undefined;
}

/**
 * A room a waiter may charge to.
 *
 * The guest's NAME and nothing else — enough to say "Mr Sharma in 204?" out loud and
 * be sure of the table. No folio id, no balance, no history. A waiter who can read a
 * guest's balance is a waiter who can read every guest's balance.
 */
@ObjectType()
export class ChargeableRoomGql {
  @Field(() => ID) roomId!: string;
  @Field() roomNumber!: string;
  @Field() guestName!: string;
}

@ObjectType()
export class ChargeResultGql {
  @Field(() => PosOrderGql) order!: PosOrderGql;
  @Field() roomNumber!: string;

  /** What went on the bill, before tax. */
  @Field(() => Int) chargedMinor!: number;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

@InputType()
export class OpenOrderGqlInput {
  @Field(() => ID) outletId!: string;
  @Field({ nullable: true }) tableRef?: string;
}

@InputType()
export class AddOrderLineGqlInput {
  @Field(() => ID) orderId!: string;
  @Field(() => ID) menuItemId!: string;
  @Field(() => Int) quantity!: number;
  @Field({ nullable: true }) notes?: string;

  /**
   * There is deliberately NO price field.
   *
   * The price comes from the menu, server-side. A POS that lets the caller name the
   * price is a POS that can sell a bottle of wine for one rupee, and the audit trail
   * will faithfully record that this is exactly what was asked for.
   */
}

@InputType()
export class RemoveOrderLineGqlInput {
  @Field(() => ID) orderId!: string;
  @Field(() => ID) lineId!: string;
}

@InputType()
export class ChargeOrderToRoomGqlInput {
  @Field(() => ID) orderId!: string;

  /** A ROOM, never a folio. The waiter does not know folios exist. */
  @Field(() => ID) roomId!: string;
}

@InputType()
export class VoidOrderGqlInput {
  @Field(() => ID) orderId!: string;
  @Field() reason!: string;
}
