/**
 * guests — PUBLIC API (TDD §2.1).
 *
 * The full ID number never leaves this module except through
 * GuestsService.revealIdNumber(), which audits the access.
 */
export { GuestsModule } from './guests.module';
export { GuestsService } from './application/guests.service';
export type { Guest, GuestInput, GuestView } from './application/guests.service';
export { GuestGql } from './graphql/guests.resolver';
