import { Args, Field, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser, PropertyId, Roles } from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { NightAuditService } from '../application/night-audit.service';

@ObjectType()
export class AuditStepGql {
  @Field() step!: string;
  @Field() status!: string;
  @Field({ nullable: true }) detail?: string;
  @Field() at!: string;
}

@ObjectType()
export class NightAuditPayloadGql {
  @Field(() => ID) runId!: string;
  @Field() businessDate!: string;
  @Field({ nullable: true }) newBusinessDate?: string;
  @Field() status!: string;
  @Field(() => [AuditStepGql]) steps!: AuditStepGql[];
}

@ObjectType()
export class NightAuditRunGql {
  @Field(() => ID) id!: string;
  @Field() businessDate!: string;
  @Field() status!: string;
  @Field({ nullable: true }) completedAt?: string;
}

@ObjectType()
export class DailyStatsGql {
  @Field() businessDate!: string;
  @Field(() => Int) roomsAvailable!: number;
  @Field(() => Int) roomsSold!: number;
  @Field(() => Int) roomsOutOfOrder!: number;

  /** Basis points — 8543 = 85.43%. */
  @Field(() => Int) occupancyBps!: number;

  @Field(() => Int) roomRevenueMinor!: number;
  @Field(() => Int) otherRevenueMinor!: number;
  @Field(() => Int) taxMinor!: number;

  /** Average Daily Rate — room revenue / rooms SOLD. */
  @Field(() => Int) adrMinor!: number;
  /** Revenue Per Available Room — room revenue / rooms AVAILABLE. */
  @Field(() => Int) revparMinor!: number;
}

@Resolver()
export class NightAuditResolver {
  constructor(private readonly audit: NightAuditService) {}

  /**
   * Run (or resume) the night audit.
   *
   * MANAGER and above only. It posts charges to every in-house guest and moves the
   * property's business date — the two things that a mistake here makes very hard to
   * undo. AUDITOR is read-only by definition and FRONT_DESK does not close the books.
   */
  @Roles('ADMIN', 'MANAGER')
  @Mutation(() => NightAuditPayloadGql)
  async runNightAudit(
    @PropertyId() propertyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NightAuditPayloadGql> {
    return (await this.audit.run({
      propertyId,
      userId: user.id,
    })) as unknown as NightAuditPayloadGql;
  }

  @Roles('ADMIN', 'MANAGER', 'AUDITOR')
  @Query(() => [NightAuditRunGql])
  async nightAuditRuns(@PropertyId() propertyId: string): Promise<NightAuditRunGql[]> {
    return (await this.audit.history(propertyId)) as unknown as NightAuditRunGql[];
  }

  /** Occupancy / ADR / RevPAR, frozen at audit time (TDD §5.2). */
  @Roles('ADMIN', 'MANAGER', 'AUDITOR')
  @Query(() => [DailyStatsGql])
  async occupancyReport(
    @PropertyId() propertyId: string,
    @Args('from') from: string,
    @Args('to') to: string,
  ): Promise<DailyStatsGql[]> {
    return (await this.audit.stats(propertyId, from, to)) as unknown as DailyStatsGql[];
  }
}
