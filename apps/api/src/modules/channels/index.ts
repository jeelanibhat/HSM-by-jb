/**
 * channels — PUBLIC API (TDD §2.1).
 *
 * The channel manager keeps availability in sync with OTAs and ingests their bookings.
 * It consumes reservations (both AvailabilityService and ReservationsService) through
 * that module's facade. Nothing consumes channels yet.
 */
export { ChannelsModule } from './channels.module';
export { ChannelConfigService } from './application/channel-config.service';
export { ChannelInboundService } from './application/channel-inbound.service';
export { ChannelSyncRelay } from './application/channel-sync.relay';
export { SimulatedOtaConnector } from './application/connector';
