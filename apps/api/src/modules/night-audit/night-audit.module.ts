import { Module } from '@nestjs/common';
import { HousekeepingModule } from '../housekeeping';
import { IdentityModule } from '../identity';
import { ReportingModule } from '../reporting';
import { NightAuditService } from './application/night-audit.service';
import { NightAuditResolver } from './graphql/night-audit.resolver';

@Module({
  imports: [IdentityModule, ReportingModule, HousekeepingModule],
  providers: [NightAuditService, NightAuditResolver],
  exports: [NightAuditService],
})
export class NightAuditModule {}
