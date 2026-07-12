/**
 * folio — PUBLIC API (TDD §2.1).
 *
 * The reservations module uses FolioService at check-in (open the bill) and at
 * check-out (assert it is settled, then close it). It must not reach into
 * folio/infra — the immutability of the ledger is this module's to guarantee.
 */
export { FolioModule } from './folio.module';
export { FolioService } from './application/folio.service';
export type { FolioBalance } from './application/folio.service';
export { FolioGql, FolioLineGql } from './graphql/folio.resolver';
