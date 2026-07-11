import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { InventoryModule } from '../inventory';
import { AvailabilityService } from './application/availability.service';
import { ReservationsService } from './application/reservations.service';
import { ReservationsResolver } from './graphql/reservations.resolver';

@Module({
  imports: [IdentityModule, InventoryModule],
  providers: [ReservationsService, AvailabilityService, ReservationsResolver],
  exports: [ReservationsService, AvailabilityService],
})
export class ReservationsModule {}
