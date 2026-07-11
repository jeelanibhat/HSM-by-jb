import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { GuestsService } from './application/guests.service';
import { GuestsResolver } from './graphql/guests.resolver';

@Module({
  imports: [IdentityModule],
  providers: [GuestsService, GuestsResolver],
  exports: [GuestsService],
})
export class GuestsModule {}
