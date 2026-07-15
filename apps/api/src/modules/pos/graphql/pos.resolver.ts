import { BadRequestException } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  addOrderLineSchema,
  chargeOrderToRoomSchema,
  openOrderSchema,
  removeOrderLineSchema,
  voidOrderSchema,
} from '@hotelos/domain';
import type { z, ZodTypeAny } from 'zod';
import { CurrentUser, PropertyId, Roles } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { PosService } from '../application/pos.service';
import {
  AddOrderLineGqlInput,
  ChargeableRoomGql,
  ChargeOrderToRoomGqlInput,
  ChargeResultGql,
  MenuItemGql,
  OpenOrderGqlInput,
  OutletGql,
  PosOrderGql,
  RemoveOrderLineGqlInput,
  VoidOrderGqlInput,
} from './pos.types';

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

/**
 * Who may work the till.
 *
 * POS_OPERATOR is a waiter. They can take an order and send it to a room — and that
 * is the whole of their authority. They cannot read a folio, take a payment, check
 * anyone in, or see what a guest owes.
 *
 * HOUSEKEEPING and AUDITOR are absent on purpose. Housekeeping does not sell food;
 * the auditor reads the books and touches nothing.
 */
const TILL = ['ADMIN', 'MANAGER', 'FRONT_DESK', 'POS_OPERATOR'] as const;

@Resolver()
export class PosResolver {
  constructor(private readonly pos: PosService) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  @Roles(...TILL)
  @Query(() => [OutletGql])
  async outlets(@PropertyId() propertyId: string): Promise<OutletGql[]> {
    return (await this.pos.listOutlets(propertyId)) as OutletGql[];
  }

  @Roles(...TILL)
  @Query(() => [MenuItemGql])
  async menu(
    @PropertyId() propertyId: string,
    @Args('outletId', { type: () => ID }) outletId: string,
  ): Promise<MenuItemGql[]> {
    return (await this.pos.listMenu(propertyId, outletId)) as unknown as MenuItemGql[];
  }

  @Roles(...TILL)
  @Query(() => [PosOrderGql])
  async openOrders(
    @PropertyId() propertyId: string,
    @Args('outletId', { type: () => ID, nullable: true }) outletId?: string,
  ): Promise<PosOrderGql[]> {
    return (await this.pos.openOrders(propertyId, outletId)) as unknown as PosOrderGql[];
  }

  @Roles(...TILL)
  @Query(() => PosOrderGql)
  async posOrder(
    @PropertyId() propertyId: string,
    @Args('orderId', { type: () => ID }) orderId: string,
  ): Promise<PosOrderGql> {
    return (await this.pos.getOrder(propertyId, orderId)) as unknown as PosOrderGql;
  }

  /**
   * The rooms with a guest actually in them.
   *
   * This is the ONLY way a waiter learns anything about who is staying, and it gives
   * them a name and a room number — enough to confirm the table, and nothing more.
   */
  @Roles(...TILL)
  @Query(() => [ChargeableRoomGql])
  async chargeableRooms(@PropertyId() propertyId: string): Promise<ChargeableRoomGql[]> {
    return (await this.pos.chargeableRooms(propertyId)) as unknown as ChargeableRoomGql[];
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  @Roles(...TILL)
  @Mutation(() => PosOrderGql)
  async openOrder(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: OpenOrderGqlInput,
  ): Promise<PosOrderGql> {
    const dto = parse(openOrderSchema, input);

    return (await this.pos.openOrder({ propertyId, userId: user.id }, {
      outletId: dto.outletId,
      ...(dto.tableRef !== undefined ? { tableRef: dto.tableRef } : {}),
    })) as unknown as PosOrderGql;
  }

  @Roles(...TILL)
  @Mutation(() => PosOrderGql)
  async addOrderLine(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: AddOrderLineGqlInput,
  ): Promise<PosOrderGql> {
    const dto = parse(addOrderLineSchema, input);

    return (await this.pos.addLine({ propertyId, userId: user.id }, {
      orderId: dto.orderId,
      menuItemId: dto.menuItemId,
      quantity: dto.quantity,
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    })) as unknown as PosOrderGql;
  }

  @Roles(...TILL)
  @Mutation(() => PosOrderGql)
  async removeOrderLine(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: RemoveOrderLineGqlInput,
  ): Promise<PosOrderGql> {
    const dto = parse(removeOrderLineSchema, input);

    return (await this.pos.removeLine(
      { propertyId, userId: user.id },
      dto,
    )) as unknown as PosOrderGql;
  }

  /**
   * Send the order to a room.
   *
   * Note what comes BACK: the order, the room number, and what was charged. Not the
   * folio id, and not the guest's balance — even though the service has both in hand.
   * The waiter learns that the meal went on the bill, not what else is on it.
   */
  @Roles(...TILL)
  @Mutation(() => ChargeResultGql)
  async chargeOrderToRoom(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: ChargeOrderToRoomGqlInput,
  ): Promise<ChargeResultGql> {
    const dto = parse(chargeOrderToRoomSchema, input);

    const result = await this.pos.chargeToRoom({ propertyId, userId: user.id }, dto);

    return {
      order: result.order as unknown as PosOrderGql,
      roomNumber: result.roomNumber,
      chargedMinor: result.chargedMinor,
    };
  }

  @Roles(...TILL)
  @Mutation(() => PosOrderGql)
  async voidOrder(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: VoidOrderGqlInput,
  ): Promise<PosOrderGql> {
    const dto = parse(voidOrderSchema, input);

    return (await this.pos.voidOrder(
      { propertyId, userId: user.id },
      dto,
    )) as unknown as PosOrderGql;
  }
}
