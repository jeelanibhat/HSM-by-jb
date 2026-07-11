/**
 * reservations — PUBLIC API (TDD §2.1).
 *
 * §2 principle 5: "Availability is sacred. The reservation/availability engine is
 * the one component designed for extraction into its own service later." Keeping
 * every consumer behind this facade is what makes that extraction a refactor
 * rather than a rewrite.
 */
export { ReservationsModule } from './reservations.module';
export { ReservationsService } from './application/reservations.service';
export { AvailabilityService, NoAvailabilityError } from './application/availability.service';
export type { AvailabilityRow } from './application/availability.service';
