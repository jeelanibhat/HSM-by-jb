import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class PropertyType {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  timezone!: string;

  @Field()
  currency!: string;

  /**
   * The business date (TDD §6) — NOT today's date. It advances only when night
   * audit runs, so a front desk still posting at 02:00 sees yesterday here. Every
   * folio posting and every report keys off this value.
   */
  @Field()
  businessDate!: string;

  @Field()
  checkInTime!: string;

  @Field()
  checkOutTime!: string;

  @Field()
  status!: string;
}
