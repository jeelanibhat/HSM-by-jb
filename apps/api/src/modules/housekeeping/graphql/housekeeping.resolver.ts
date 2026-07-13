import { BadRequestException } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import {
  assignHousekeepingTaskSchema,
  completeHousekeepingTaskSchema,
  createHousekeepingTaskSchema,
  generateHousekeepingBoardSchema,
  inspectHousekeepingTaskSchema,
  startHousekeepingTaskSchema,
  type Role,
} from '@hotelos/domain';
import type { z, ZodTypeAny } from 'zod';
import { CurrentUser, PropertyId, Roles } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { HousekeepingService } from '../application/housekeeping.service';
import {
  AssignHousekeepingTaskGqlInput,
  CompleteHousekeepingTaskGqlInput,
  CreateHousekeepingTaskGqlInput,
  GenerateBoardResultGql,
  GenerateHousekeepingBoardGqlInput,
  HousekeepingAttendantGql,
  HousekeepingTaskGql,
  InspectHousekeepingTaskGqlInput,
  StartHousekeepingTaskGqlInput,
} from './housekeeping.types';

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
 * Who runs the floor. Supervisors may assign work, sign it off, and — because
 * somebody has to cover an attendant who went home sick — work anyone's task.
 */
const SUPERVISORS: readonly Role[] = ['ADMIN', 'MANAGER'];

@Resolver()
export class HousekeepingResolver {
  constructor(private readonly housekeeping: HousekeepingService) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /**
   * The day's board.
   *
   * No @Roles(): the front desk needs to know which rooms are ready before they hand
   * anyone a key, and housekeeping obviously needs their own work. There is nothing
   * on this board that is anyone's private business — no money, no guest data, just
   * rooms and who is cleaning them.
   */
  @Query(() => [HousekeepingTaskGql])
  async housekeepingBoard(
    @PropertyId() propertyId: string,
    @Args('date', { nullable: true }) date?: string,
  ): Promise<HousekeepingTaskGql[]> {
    return (await this.housekeeping.board(propertyId, date)) as unknown as HousekeepingTaskGql[];
  }

  /** Who a supervisor can hand a room to. */
  @Roles('ADMIN', 'MANAGER')
  @Query(() => [HousekeepingAttendantGql])
  async housekeepingAttendants(
    @PropertyId() propertyId: string,
  ): Promise<HousekeepingAttendantGql[]> {
    return this.housekeeping.attendants(propertyId);
  }

  // ── Supervisor work ────────────────────────────────────────────────────────

  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => GenerateBoardResultGql)
  async generateHousekeepingBoard(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input', { nullable: true }) input?: GenerateHousekeepingBoardGqlInput,
  ): Promise<GenerateBoardResultGql> {
    const dto = parse(generateHousekeepingBoardSchema, input ?? {});
    return this.housekeeping.generateBoard(
      { propertyId, userId: user.id },
      dto.businessDate,
    );
  }

  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => HousekeepingTaskGql)
  async createHousekeepingTask(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: CreateHousekeepingTaskGqlInput,
  ): Promise<HousekeepingTaskGql> {
    const dto = parse(createHousekeepingTaskSchema, input);

    return (await this.housekeeping.createTask({ propertyId, userId: user.id }, {
      roomId: dto.roomId,
      type: dto.type,
      ...(dto.businessDate !== undefined ? { businessDate: dto.businessDate } : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    })) as unknown as HousekeepingTaskGql;
  }

  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => HousekeepingTaskGql)
  async assignHousekeepingTask(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: AssignHousekeepingTaskGqlInput,
  ): Promise<HousekeepingTaskGql> {
    const dto = parse(assignHousekeepingTaskSchema, {
      taskId: input.taskId,
      assignedTo: input.assignedTo ?? null,
    });

    return (await this.housekeeping.assign(
      { propertyId, userId: user.id },
      dto,
    )) as unknown as HousekeepingTaskGql;
  }

  /**
   * Sign the room off — or send it back.
   *
   * SUPERVISORS ONLY, and that is the point of the whole module. An attendant who
   * could inspect their own work has not been inspected. The front desk cannot do it
   * either: they have every incentive to pass a room they are about to sell.
   */
  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => HousekeepingTaskGql)
  async inspectHousekeepingTask(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: InspectHousekeepingTaskGqlInput,
  ): Promise<HousekeepingTaskGql> {
    const dto = parse(inspectHousekeepingTaskSchema, input);

    return (await this.housekeeping.inspect(
      { propertyId, userId: user.id },
      dto.taskId,
      dto.passed,
      dto.reason,
    )) as unknown as HousekeepingTaskGql;
  }

  // ── Attendant work ─────────────────────────────────────────────────────────
  //
  // Housekeeping plus supervisors. NOT front desk and NOT the auditor: neither of
  // them cleans rooms, and a "done" from someone who was not in the room is exactly
  // the lie inspection exists to catch.

  @Roles('ADMIN', 'MANAGER', 'HOUSEKEEPING')
  @Mutation(() => HousekeepingTaskGql)
  async startHousekeepingTask(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: StartHousekeepingTaskGqlInput,
  ): Promise<HousekeepingTaskGql> {
    const dto = parse(startHousekeepingTaskSchema, input);

    return (await this.housekeeping.start(
      { propertyId, userId: user.id },
      dto.taskId,
      this.isSupervisor(user, propertyId),
    )) as unknown as HousekeepingTaskGql;
  }

  @Roles('ADMIN', 'MANAGER', 'HOUSEKEEPING')
  @Mutation(() => HousekeepingTaskGql)
  async completeHousekeepingTask(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Args('input') input: CompleteHousekeepingTaskGqlInput,
  ): Promise<HousekeepingTaskGql> {
    const dto = parse(completeHousekeepingTaskSchema, input);

    return (await this.housekeeping.complete(
      { propertyId, userId: user.id },
      dto.taskId,
      this.isSupervisor(user, propertyId),
      dto.notes,
    )) as unknown as HousekeepingTaskGql;
  }

  /** The role this user holds AT THIS PROPERTY — never a role they hold elsewhere. */
  private isSupervisor(user: AuthenticatedUser, propertyId: string): boolean {
    const role = user.roles.find((r) => r.propertyId === propertyId)?.role;
    return role !== undefined && SUPERVISORS.includes(role);
  }
}
