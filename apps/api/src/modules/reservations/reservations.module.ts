import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { InventoryModule } from '../inventory';
import { AvailabilityService } from './application/availability.service';
import { ReservationsService } from './application/reservations.service';
import { TapeChartService } from './application/tape-chart.service';
import { ReservationsResolver } from './graphql/reservations.resolver';
import { TapeChartResolver } from './graphql/tape-chart.resolver';

@Module({
  imports: [IdentityModule, InventoryModule],
  providers: [
    ReservationsService,
    AvailabilityService,
    TapeChartService,
    ReservationsResolver,
    TapeChartResolver,
  ],
  exports: [ReservationsService, AvailabilityService, TapeChartService],
})
export class ReservationsModule {}
