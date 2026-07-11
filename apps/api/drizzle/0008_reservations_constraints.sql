-- Reservations: the guarantees that live in the database (TDD §4.3, §6).

--------------------------------------------------------------------------------
-- Grants + RLS for the two new schemas. A new schema inherits NOTHING from the
-- ALTER DEFAULT PRIVILEGES set in 0002/0006 — see the note in 0006.
--------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA "guests", "reservations" TO hotelos_app;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA "guests", "reservations" TO hotelos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "guests", "reservations" TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "guests", "reservations"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "guests", "reservations"
  GRANT USAGE, SELECT ON SEQUENCES TO hotelos_app;

ALTER TABLE "guests"."guests"                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "guests"."guests"                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "reservations"."reservations"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservations"."reservations"          FORCE  ROW LEVEL SECURITY;
ALTER TABLE "reservations"."reservation_rooms"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservations"."reservation_rooms"     FORCE  ROW LEVEL SECURITY;
ALTER TABLE "reservations"."room_type_availability" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reservations"."room_type_availability" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "guests"."guests"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

CREATE POLICY tenant_isolation ON "reservations"."reservations"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

CREATE POLICY tenant_isolation ON "reservations"."reservation_rooms"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

CREATE POLICY tenant_isolation ON "reservations"."room_type_availability"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

--------------------------------------------------------------------------------
-- The stay, as a range. Generated, so it can never disagree with the two date
-- columns it is derived from.
--
-- '[)' is HALF-OPEN and it is the whole ballgame: the departure date is NOT part
-- of the stay. Guest A departing the 3rd and guest B arriving the 3rd do not
-- overlap, so the same room can legally be sold to both — same-day turnover, the
-- single most common thing a hotel does. A '[]' closed range here would reject
-- that booking and idle the room for a night.
--------------------------------------------------------------------------------
ALTER TABLE "reservations"."reservation_rooms"
  ADD COLUMN stay daterange
  GENERATED ALWAYS AS (daterange(arrival_date, departure_date, '[)')) STORED;

--------------------------------------------------------------------------------
-- HARD double-booking prevention (TDD §4.3).
--
-- This is the constraint the whole design leans on: "The exclusion constraint is
-- the final guarantee against assigned-room overlaps." Even with every line of
-- application code wrong, a race between two check-in clerks, or a bad migration,
-- Postgres will not let one physical room be held by two overlapping live stays.
--
-- It needs btree_gist, because it mixes an equality operator (room_id WITH =)
-- with a range-overlap operator (stay WITH &&) in one GiST index.
--
-- The WHERE clause matters as much as the constraint:
--   room_id IS NOT NULL  — an unassigned booking holds a room TYPE, not a room.
--                          Two unassigned bookings are two rooms sold, not a clash.
--   status NOT IN (...)  — a cancelled or no-show stay releases its room. This
--                          predicate is the DB's copy of occupiesInventory() in
--                          the domain package; they must not drift.
--------------------------------------------------------------------------------
ALTER TABLE "reservations"."reservation_rooms"
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (
    room_id WITH =,
    stay    WITH &&
  )
  WHERE (room_id IS NOT NULL AND status NOT IN ('CANCELLED', 'NO_SHOW'));

--------------------------------------------------------------------------------
-- Confirmation numbers. A global sequence, so two properties booking at the same
-- instant cannot collide; the per-property UNIQUE index is belt and braces.
--------------------------------------------------------------------------------
CREATE SEQUENCE "reservations".confirmation_seq START 100000;
GRANT USAGE, SELECT ON SEQUENCE "reservations".confirmation_seq TO hotelos_app;

--------------------------------------------------------------------------------
-- Reservation status must be one the state machine knows. A typo would create a
-- seventh status that no code handles — and, worse, one that the exclusion
-- constraint's NOT IN ('CANCELLED','NO_SHOW') would treat as LIVE, silently
-- holding a room forever.
--------------------------------------------------------------------------------
ALTER TABLE "reservations"."reservations" ADD CONSTRAINT reservations_status_valid
  CHECK (status IN ('ENQUIRY','CONFIRMED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW'));

ALTER TABLE "reservations"."reservation_rooms" ADD CONSTRAINT res_rooms_status_valid
  CHECK (status IN ('ENQUIRY','CONFIRMED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW'));

ALTER TABLE "reservations"."reservations" ADD CONSTRAINT reservations_source_valid
  CHECK (source IN ('WALK_IN','DIRECT','PHONE','OTA','BOOKING_ENGINE'));

ALTER TABLE "reservations"."reservations" ADD CONSTRAINT reservations_occupancy_sane
  CHECK (adults >= 1 AND children >= 0);

--------------------------------------------------------------------------------
-- Same guard as 0006: every table carrying property_id must have forced RLS.
--------------------------------------------------------------------------------
DO $$
DECLARE
  unprotected text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ')
    INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'property_id' AND a.attnum > 0
  WHERE c.relkind = 'r'
    AND n.nspname IN ('inventory','property','identity','shared','guests','reservations')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'Tables carry property_id but have no forced RLS: %. Add ENABLE + FORCE ROW LEVEL SECURITY and a tenant policy.',
      unprotected;
  END IF;
END
$$;
