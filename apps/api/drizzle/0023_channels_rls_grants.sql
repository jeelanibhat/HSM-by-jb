-- Grants, RLS and value constraints for the new `channel` schema.
--
-- A brand-new schema inherits none of migration 0002's grants or default privileges.
-- Access without policies leaks every hotel's channel config, availability pushes and
-- OTA bookings to every other hotel; policies without access is a 500 on the first
-- booking. Both halves, always.

GRANT USAGE ON SCHEMA "channel" TO hotelos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "channel" TO hotelos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "channel" TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "channel"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "channel"
  GRANT USAGE, SELECT ON SEQUENCES TO hotelos_app;
--> statement-breakpoint

-- ENABLE *and* FORCE on the four API-visible tables: ENABLE alone still lets the table
-- OWNER bypass the policy, and migrations run as the owner.
--
-- channel_outbound is deliberately NOT among them. It is a system queue drained by a
-- cross-tenant background relay, exactly like shared.outbox_events (migration 0001): the
-- relay must read every property's due pushes to find the work, which forced RLS would
-- hide from it. Its property_id travels in the row, and the relay opens a property-scoped
-- transaction from it before touching any tenant data. The read paths that surface the
-- queue in the UI filter property_id explicitly.
ALTER TABLE "channel"."channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel"."channels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "channel"."channels"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());
--> statement-breakpoint

ALTER TABLE "channel"."channel_room_type_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel"."channel_room_type_mappings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "channel"."channel_room_type_mappings"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());
--> statement-breakpoint

ALTER TABLE "channel"."channel_rate_plan_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel"."channel_rate_plan_mappings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "channel"."channel_rate_plan_mappings"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());
--> statement-breakpoint

ALTER TABLE "channel"."channel_bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel"."channel_bookings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "channel"."channel_bookings"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());
--> statement-breakpoint

-- The state machines live in @hotelos/domain, but the database is the last line: a bad
-- deploy or a stray script must not be able to write a status nothing has heard of.
ALTER TABLE "channel"."channel_outbound"
  ADD CONSTRAINT channel_outbound_status_valid
  CHECK (status IN ('PENDING', 'SENT', 'FAILED'));
--> statement-breakpoint

ALTER TABLE "channel"."channel_outbound"
  ADD CONSTRAINT channel_outbound_attempts_not_negative
  CHECK (attempts >= 0);
--> statement-breakpoint

-- A push over a backwards date range is a query that returns nothing and a bug that
-- hides.
ALTER TABLE "channel"."channel_outbound"
  ADD CONSTRAINT channel_outbound_dates_ordered
  CHECK (to_date >= from_date);
--> statement-breakpoint

ALTER TABLE "channel"."channel_bookings"
  ADD CONSTRAINT channel_bookings_status_valid
  CHECK (status IN ('RECEIVED', 'CONFIRMED', 'REJECTED', 'DUPLICATE'));
--> statement-breakpoint

-- A CONFIRMED booking must name the reservation it became. A booking marked confirmed
-- with no reservation is a guest the OTA believes is booked and the hotel has no record
-- of — the exact oversell this module exists to prevent.
ALTER TABLE "channel"."channel_bookings"
  ADD CONSTRAINT channel_bookings_confirmed_has_reservation
  CHECK (status <> 'CONFIRMED' OR reservation_id IS NOT NULL);
