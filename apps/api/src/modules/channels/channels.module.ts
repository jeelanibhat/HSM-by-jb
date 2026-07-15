import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { ReservationsModule } from '../reservations';
import { ChannelConfigService } from './application/channel-config.service';
import { ChannelInboundService } from './application/channel-inbound.service';
import { ChannelOutboundWorker } from './application/channel-outbound.worker';
import { ChannelSyncRelay } from './application/channel-sync.relay';
import { CHANNEL_CONNECTOR, SimulatedOtaConnector } from './application/connector';
import { ChannelResolver } from './graphql/channel.resolver';

/**
 * Channel manager (Phase 2).
 *
 * Consumes ReservationsModule both ways: AvailabilityService to compute what to push OUT,
 * and ReservationsService to turn a delivered booking IN to a reservation — through the
 * facade, never the internals, so the availability engine stays extractable.
 *
 * The connector is bound behind a token: swap SimulatedOtaConnector for a real one and
 * nothing else in the module changes.
 */
@Module({
  imports: [IdentityModule, ReservationsModule],
  providers: [
    ChannelConfigService,
    ChannelInboundService,
    ChannelOutboundWorker,
    ChannelSyncRelay,
    ChannelResolver,
    SimulatedOtaConnector,
    { provide: CHANNEL_CONNECTOR, useExisting: SimulatedOtaConnector },
  ],
  exports: [ChannelConfigService, ChannelInboundService, ChannelSyncRelay, SimulatedOtaConnector],
})
export class ChannelsModule {}
