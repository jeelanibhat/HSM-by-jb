/**
 * inventory — PUBLIC API (TDD §2.1).
 *
 * The reservations module consumes InventoryService for room lookups and for the
 * system-driven room-status changes at check-in/out. It must not reach into
 * inventory/infra or inventory/application directly — ESLint enforces that.
 */
export { InventoryModule } from './inventory.module';
export { InventoryService } from './application/inventory.service';
export { RoomGql, RoomTypeGql, RatePlanGql, RatePriceGql } from './graphql/inventory.types';
