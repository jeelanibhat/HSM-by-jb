/**
 * reporting — PUBLIC API (TDD §2.1).
 *
 * Owns the `reporting` schema. night-audit writes the nightly snapshot through
 * ReportingService.snapshotDaily(), never by touching the table directly — the
 * boundary is what stops the frozen numbers acquiring a second author.
 */
export { ReportingModule } from './reporting.module';
export { ReportingService } from './application/reporting.service';
export type {
  DailyRevenueReport,
  DailySnapshot,
  RevenueLine,
} from './application/reporting.service';
