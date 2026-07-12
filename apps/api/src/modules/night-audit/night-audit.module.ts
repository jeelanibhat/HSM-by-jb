import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { ReportingModule } from '../reporting';
import { NightAuditService } from './application/night-audit.service';
import { NightAuditResolver } from './graphql/night-audit.resolver';

@Module({
  imports: [IdentityModule, ReportingModule],
  providers: [NightAuditService, NightAuditResolver],
  exports: [NightAuditService],
})
export class NightAuditModule {}
