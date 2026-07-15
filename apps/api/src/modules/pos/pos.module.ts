import { Module } from '@nestjs/common';
import { FolioModule } from '../folio';
import { IdentityModule } from '../identity';
import { PosService } from './application/pos.service';
import { PosResolver } from './graphql/pos.resolver';

@Module({
  imports: [IdentityModule, FolioModule],
  providers: [PosService, PosResolver],
  exports: [PosService],
})
export class PosModule {}
