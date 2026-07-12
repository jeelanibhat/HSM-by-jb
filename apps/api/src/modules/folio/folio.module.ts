import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { FolioService } from './application/folio.service';
import { FolioResolver } from './graphql/folio.resolver';

@Module({
  imports: [IdentityModule],
  providers: [FolioService, FolioResolver],
  exports: [FolioService],
})
export class FolioModule {}
