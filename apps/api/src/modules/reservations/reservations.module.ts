import { Module } from '@nestjs/common';
import { FolioModule } from '../folio';
import { IdentityModule } from '../identity';
import { InventoryModule } from '../inventory';
import { AvailabilityService } from './application/availability.service';
import { FrontDeskService } from './application/front-desk.service';
import { ReservationsService } from './application/reservations.service';
import { QuoteService } from './application/quote.service';
import { StayService } from './application/stay.service';
import { TapeChartService } from './application/tape-chart.service';
import { FrontDeskResolver } from './graphql/front-desk.resolver';
import { ReservationsResolver } from './graphql/reservations.resolver';
import { TapeChartResolver } from './graphql/tape-chart.resolver';

@Module({
  // FolioModule: check-in opens the bill, check-out refuses to close on a
  // non-zero balance. Imported through its facade, never its internals.
  imports: [IdentityModule, InventoryModule, FolioModule],
  providers: [
    ReservationsService,
    AvailabilityService,
    StayService,
    QuoteService,
    TapeChartService,
    FrontDeskService,
    ReservationsResolver,
    TapeChartResolver,
    FrontDeskResolver,
  ],
  exports: [ReservationsService, AvailabilityService, TapeChartService, StayService],
})
export class ReservationsModule {}
