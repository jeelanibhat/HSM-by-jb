/**
 * pos — PUBLIC API (TDD §2.1).
 *
 * POS consumes FolioService (through folio's barrel) to put a meal on a guest's bill.
 * Nothing consumes POS yet. Reporting will, when F&B revenue joins the daily stats.
 */
export { PosModule } from './pos.module';
export { PosService } from './application/pos.service';
export { PosOrderGql } from './graphql/pos.types';
