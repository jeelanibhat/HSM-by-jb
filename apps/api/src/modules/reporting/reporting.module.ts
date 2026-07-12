import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { ReportingService } from './application/reporting.service';
import { ReportingResolver } from './graphql/reporting.resolver';

@Module({
  imports: [IdentityModule],
  providers: [ReportingService, ReportingResolver],
  exports: [ReportingService],
})
export class ReportingModule {}
