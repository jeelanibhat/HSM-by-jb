import { Args, Field, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { PropertyId, Roles } from '../../identity';
import { ReportingService } from '../application/reporting.service';

@ObjectType()
export class DailyStatsGql {
  @Field() businessDate!: string;
  @Field(() => Int) roomsAvailable!: number;
  @Field(() => Int) roomsSold!: number;
  @Field(() => Int) roomsOutOfOrder!: number;

  /** Basis points — 8543 = 85.43%. Integer, never a float. */
  @Field(() => Int) occupancyBps!: number;

  @Field(() => Int) roomRevenueMinor!: number;
  @Field(() => Int) otherRevenueMinor!: number;
  @Field(() => Int) taxMinor!: number;

  /** Average Daily Rate — room revenue / rooms SOLD. */
  @Field(() => Int) adrMinor!: number;
  /** Revenue Per Available Room — room revenue / rooms AVAILABLE. */
  @Field(() => Int) revparMinor!: number;
}

@ObjectType()
export class RevenueLineGql {
  @Field() code!: string;
  @Field(() => Int) count!: number;
  @Field(() => Int) amountMinor!: number;
}

@ObjectType()
export class DailyRevenueReportGql {
  @Field() businessDate!: string;
  @Field() currency!: string;

  @Field(() => [RevenueLineGql]) revenue!: RevenueLineGql[];
  @Field(() => [RevenueLineGql]) payments!: RevenueLineGql[];
  @Field(() => [RevenueLineGql]) adjustments!: RevenueLineGql[];

  @Field(() => Int) roomRevenueMinor!: number;
  @Field(() => Int) otherRevenueMinor!: number;
  @Field(() => Int) taxMinor!: number;
  @Field(() => Int) grossRevenueMinor!: number;

  @Field(() => Int) paymentsMinor!: number;
  @Field(() => Int) adjustmentsMinor!: number;

  /** Trial balance: what guests in the building still owe (TDD §6 step 5). */
  @Field(() => Int) outstandingMinor!: number;
  @Field(() => Int) openFolios!: number;

  /** Null until the night audit has run for this date. */
  @Field(() => DailyStatsGql, { nullable: true }) snapshot?: DailyStatsGql;
}

/**
 * Reports are read-only by nature, so AUDITOR belongs here — it is the one role
 * whose entire job is looking at these numbers without being able to move them.
 * FRONT_DESK and HOUSEKEEPING are absent: neither needs the hotel's revenue.
 */
@Resolver()
export class ReportingResolver {
  constructor(private readonly reporting: ReportingService) {}

  @Roles('ADMIN', 'MANAGER', 'AUDITOR')
  @Query(() => [DailyStatsGql])
  async occupancyReport(
    @PropertyId() propertyId: string,
    @Args('from') from: string,
    @Args('to') to: string,
  ): Promise<DailyStatsGql[]> {
    return (await this.reporting.occupancyReport(
      propertyId,
      from,
      to,
    )) as unknown as DailyStatsGql[];
  }

  @Roles('ADMIN', 'MANAGER', 'AUDITOR')
  @Query(() => DailyRevenueReportGql)
  async dailyRevenueReport(
    @PropertyId() propertyId: string,
    @Args('date') date: string,
  ): Promise<DailyRevenueReportGql> {
    return (await this.reporting.dailyRevenue(
      propertyId,
      date,
    )) as unknown as DailyRevenueReportGql;
  }
}
