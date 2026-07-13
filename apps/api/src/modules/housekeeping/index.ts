/**
 * housekeeping — PUBLIC API (TDD §2.1).
 *
 * Nothing consumes this yet. When the night audit starts generating tomorrow's board
 * it will use HousekeepingService — and it must come through this file, not reach
 * into infra/ or application/. ESLint enforces that.
 */
export { HousekeepingModule } from './housekeeping.module';
export { HousekeepingService } from './application/housekeeping.service';
export { HousekeepingTaskGql } from './graphql/housekeeping.types';
