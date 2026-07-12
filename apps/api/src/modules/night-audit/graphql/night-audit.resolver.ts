import { Field, ID, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
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

@Resolver()
export class NightAuditResolver {
  constructor(private readonly audit: NightAuditService) {}

  /**
   * Run (or resume) the night audit.
   *
   * MANAGER and above only. It posts charges to every in-house guest and moves the
   * property's business date — the two things a mistake here makes hardest to undo.
   * AUDITOR is read-only by definition; FRONT_DESK does not close the books.
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
}
