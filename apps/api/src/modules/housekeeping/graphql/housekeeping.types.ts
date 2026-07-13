import { Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import {
  HOUSEKEEPING_TASK_STATUSES,
  HOUSEKEEPING_TASK_TYPES,
  ROOM_STATUSES,
  type HousekeepingTaskStatus,
  type HousekeepingTaskType,
  type RoomStatus,
} from '@hotelos/domain';

export const HousekeepingTaskTypeEnum = Object.fromEntries(
  HOUSEKEEPING_TASK_TYPES.map((t) => [t, t]),
) as Record<HousekeepingTaskType, HousekeepingTaskType>;

registerEnumType(HousekeepingTaskTypeEnum, {
  name: 'HousekeepingTaskType',
  description: 'DEPARTURE (turnover) | STAYOVER (service) | DEEP_CLEAN | TURNDOWN',
});

export const HousekeepingTaskStatusEnum = Object.fromEntries(
  HOUSEKEEPING_TASK_STATUSES.map((s) => [s, s]),
) as Record<HousekeepingTaskStatus, HousekeepingTaskStatus>;

registerEnumType(HousekeepingTaskStatusEnum, {
  name: 'HousekeepingTaskStatus',
  description:
    'PENDING | IN_PROGRESS | DONE (the attendant says so) | INSPECTED (a supervisor checked)',
});

const RoomStatusRef = Object.fromEntries(ROOM_STATUSES.map((s) => [s, s])) as Record<
  RoomStatus,
  RoomStatus
>;

@ObjectType()
export class HousekeepingTaskGql {
  @Field(() => ID) id!: string;
  @Field(() => ID) roomId!: string;

  /** The room as a person refers to it — "204", not a UUID. */
  @Field() roomNumber!: string;

  /**
   * Every nullable field here declares its type EXPLICITLY. `exactOptionalPropertyTypes`
   * makes these `string | undefined`, and Nest's reflection cannot read a union — it
   * fails at schema build with "Undefined type error", not at compile time.
   */
  @Field(() => String, { nullable: true }) roomFloor?: string | undefined;
  @Field() roomTypeCode!: string;

  /** The room's own status, so the board can show task and room disagreeing. */
  @Field(() => String) roomStatus!: RoomStatus;

  @Field() businessDate!: string;
  @Field(() => HousekeepingTaskTypeEnum) type!: HousekeepingTaskType;
  @Field(() => HousekeepingTaskStatusEnum) status!: HousekeepingTaskStatus;

  @Field(() => ID, { nullable: true }) assignedTo?: string | undefined;
  @Field(() => String, { nullable: true }) assigneeName?: string | undefined;

  /** Roughly minutes of work. The supervisor balances on this, not on room count. */
  @Field(() => Int) credits!: number;

  @Field(() => String, { nullable: true }) notes?: string | undefined;

  /** Why the supervisor sent it back. */
  @Field(() => String, { nullable: true }) inspectionNote?: string | undefined;
  @Field(() => Int) failedInspections!: number;

  @Field(() => Date, { nullable: true }) startedAt?: Date | undefined;
  @Field(() => Date, { nullable: true }) completedAt?: Date | undefined;
  @Field(() => Date, { nullable: true }) inspectedAt?: Date | undefined;
}

@ObjectType()
export class HousekeepingAttendantGql {
  @Field(() => ID) id!: string;
  @Field() name!: string;
}

@ObjectType()
export class GenerateBoardResultGql {
  @Field(() => Int) created!: number;
  @Field() businessDate!: string;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

@InputType()
export class GenerateHousekeepingBoardGqlInput {
  @Field({ nullable: true }) businessDate?: string;
}

@InputType()
export class CreateHousekeepingTaskGqlInput {
  @Field(() => ID) roomId!: string;
  @Field(() => HousekeepingTaskTypeEnum) type!: HousekeepingTaskType;
  @Field({ nullable: true }) businessDate?: string;
  @Field({ nullable: true }) notes?: string;
}

@InputType()
export class AssignHousekeepingTaskGqlInput {
  @Field(() => ID) taskId!: string;

  /** null puts the task back on the board for anyone to pick up. */
  @Field(() => ID, { nullable: true }) assignedTo?: string | null;
}

@InputType()
export class StartHousekeepingTaskGqlInput {
  @Field(() => ID) taskId!: string;
}

@InputType()
export class CompleteHousekeepingTaskGqlInput {
  @Field(() => ID) taskId!: string;
  @Field({ nullable: true }) notes?: string;
}

@InputType()
export class InspectHousekeepingTaskGqlInput {
  @Field(() => ID) taskId!: string;
  @Field() passed!: boolean;

  /** Required in spirit when passed = false: "failed" alone is not actionable. */
  @Field({ nullable: true }) reason?: string;
}

export { RoomStatusRef };
