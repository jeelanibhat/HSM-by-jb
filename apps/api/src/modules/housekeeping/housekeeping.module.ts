import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { HousekeepingService } from './application/housekeeping.service';
import { HousekeepingResolver } from './graphql/housekeeping.resolver';

@Module({
  imports: [IdentityModule],
  providers: [HousekeepingService, HousekeepingResolver],
  exports: [HousekeepingService],
})
export class HousekeepingModule {}
