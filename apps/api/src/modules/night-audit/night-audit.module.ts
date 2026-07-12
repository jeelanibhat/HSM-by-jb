import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { NightAuditService } from './application/night-audit.service';
import { NightAuditResolver } from './graphql/night-audit.resolver';

@Module({
  imports: [IdentityModule],
  providers: [NightAuditService, NightAuditResolver],
  exports: [NightAuditService],
})
export class NightAuditModule {}
