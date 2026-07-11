import { BadRequestException } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  allowedManualRoomTransitions,
  createRatePlanSchema,
  createRoomSchema,
  createRoomTypeSchema,
  setRatePricesSchema,
  updateRoomStatusSchema,
  type RoomStatus,
} from '@hotelos/domain';
import type { z, ZodTypeAny } from 'zod';
import { CurrentUser, PropertyId, Roles } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { InventoryService } from '../application/inventory.service';
import {
  CreateRatePlanGqlInput,
  CreateRoomGqlInput,
  CreateRoomTypeGqlInput,
  RatePlanGql,
  RatePriceGql,
  RoomGql,
  RoomTypeGql,
  SetRatePricesGqlInput,
  UpdateRoomStatusGqlInput,
} from './inventory.types';

/**
 * Validate at the boundary with the SAME schema the web forms use (TDD §7.1).
 *
 * Typed on z.output, not z.input: schemas with .default() (mealPlan) have an
 * optional input but a REQUIRED output, and binding to the input type would make
 * every defaulted field look optional downstream.
 */
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
export class InventoryResolver {
  constructor(private readonly inventory: InventoryService) {}

  // ── Reads: any authenticated user AT this property ─────────────────────────
  // No @Roles() — housekeeping needs the room list as much as the front desk.
  // The guards above have already established identity and property access.

  @Query(() => [RoomTypeGql])
  async roomTypes(@PropertyId() propertyId: string): Promise<RoomTypeGql[]> {
    return (await this.inventory.listRoomTypes(propertyId)) as RoomTypeGql[];
  }

  @Query(() => [RoomGql])
  async rooms(@PropertyId() propertyId: string): Promise<RoomGql[]> {
    const rows = await this.inventory.listRooms(propertyId);

    return rows.map((r) => ({
      ...r,
      floor: r.floor ?? undefined,
      statusNote: r.statusNote ?? undefined,
      status: r.status as RoomStatus,
      // Computed here, not in the client: the rule lives in the domain package,
      // and a client that computed it could get it wrong and offer an illegal move.
      allowedTransitions: [...allowedManualRoomTransitions(r.status as RoomStatus)],
    })) as RoomGql[];
  }

  @Query(() => [RatePlanGql])
  async ratePlans(@PropertyId() propertyId: string): Promise<RatePlanGql[]> {
    return (await this.inventory.listRatePlans(propertyId)) as RatePlanGql[];
  }

  @Query(() => [RatePriceGql])
  async ratePrices(
    @PropertyId() propertyId: string,
    @Args('roomTypeId', { type: () => ID }) roomTypeId: string,
    @Args('from') from: string,
    @Args('to') to: string,
  ): Promise<RatePriceGql[]> {
    return (await this.inventory.listRatePrices(
      propertyId,
      roomTypeId,
      from,
      to,
    )) as RatePriceGql[];
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /** Defining inventory is an owner's decision, not a shift worker's. */
  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => RoomTypeGql)
  async createRoomType(
    @Args('input') input: CreateRoomTypeGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomTypeGql> {
    const data = parse(createRoomTypeSchema, input);
    return (await this.inventory.createRoomType(
      { propertyId, userId: user.id },
      data,
    )) as RoomTypeGql;
  }

  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => RoomGql)
  async createRoom(
    @Args('input') input: CreateRoomGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomGql> {
    const data = parse(createRoomSchema, input);
    const room = await this.inventory.createRoom({ propertyId, userId: user.id }, data);

    return {
      ...room,
      floor: room.floor ?? undefined,
      statusNote: room.statusNote ?? undefined,
      status: room.status as RoomStatus,
      allowedTransitions: [...allowedManualRoomTransitions(room.status as RoomStatus)],
    } as RoomGql;
  }

  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => RatePlanGql)
  async createRatePlan(
    @Args('input') input: CreateRatePlanGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RatePlanGql> {
    const data = parse(createRatePlanSchema, input);
    return (await this.inventory.createRatePlan(
      { propertyId, userId: user.id },
      data,
    )) as RatePlanGql;
  }

  /** Pricing is revenue management — a front desk agent must not move rates. */
  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => Number)
  async setRatePrices(
    @Args('input') input: SetRatePricesGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<number> {
    const data = parse(setRatePricesSchema, input);
    return this.inventory.setRatePrices({ propertyId, userId: user.id }, data);
  }

  /**
   * Room status. HOUSEKEEPING is the whole point of this endpoint — they are the
   * ones turning rooms over. FRONT_DESK too (a guest reports a broken shower).
   * AUDITOR is deliberately absent: read-only by definition.
   */
  @Roles('ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING')
  @Mutation(() => RoomGql)
  async updateRoomStatus(
    @Args('input') input: UpdateRoomStatusGqlInput,
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomGql> {
    const data = parse(updateRoomStatusSchema, input);

    const room = await this.inventory.updateRoomStatus({ propertyId, userId: user.id }, data);

    return {
      ...room,
      floor: room.floor ?? undefined,
      statusNote: room.statusNote ?? undefined,
      status: room.status as RoomStatus,
      allowedTransitions: [...allowedManualRoomTransitions(room.status as RoomStatus)],
    } as RoomGql;
  }
}
