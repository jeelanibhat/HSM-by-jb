-- Night audit: grants, RLS, and the guard that makes a double-run harmless.

--------------------------------------------------------------------------------
-- reporting schema grants. (A new schema inherits nothing — see 0006.)
--------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA "reporting" TO hotelos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "reporting" TO hotelos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "reporting" TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "reporting"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelos_app;

ALTER TABLE "reporting"."daily_stats" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reporting"."daily_stats" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "reporting"."daily_stats"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

--------------------------------------------------------------------------------
-- THE GUARD THAT MATTERS.
--
-- One ROOM charge per reservation-room per business date.
--
-- The worst thing a night audit can do is charge a guest twice for the same night.
-- It is also the most likely thing to happen: the audit fails half way through at
-- 3am, the operator re-runs it, and step 1 posts every room charge a second time.
-- The application checks for an existing charge — but the application is not what
-- an exhausted operator is relying on at 3am, and two audits racing (a cron
-- overlapping a manual run) would both pass that check before either wrote a row.
--
-- This index means the second INSERT cannot land. `ON CONFLICT DO NOTHING` turns it
-- into a silent no-op, which is exactly the right behaviour for a resumed audit:
-- the night is already charged, move on.
--------------------------------------------------------------------------------
CREATE UNIQUE INDEX folio_lines_one_room_charge_per_night
  ON "folio"."folio_lines" (reservation_room_id, business_date)
  WHERE reservation_room_id IS NOT NULL
    AND code = 'ROOM'
    AND type = 'CHARGE'
    AND source_module = 'night-audit';

-- The room charge must point at a real room-night.
ALTER TABLE "folio"."folio_lines" ADD CONSTRAINT folio_lines_reservation_room_fk
  FOREIGN KEY (reservation_room_id)
  REFERENCES "reservations"."reservation_rooms"(id);

--------------------------------------------------------------------------------
-- Sanity constraints on the frozen snapshot. A negative occupancy or a hotel that
-- sold more rooms than it has is a bug, and it must not be silently recorded and
-- then reported to an owner.
--------------------------------------------------------------------------------
ALTER TABLE "reporting"."daily_stats" ADD CONSTRAINT daily_stats_sane
  CHECK (
    rooms_available >= 0
    AND rooms_sold >= 0
    AND rooms_sold <= rooms_available
    AND occupancy_bps BETWEEN 0 AND 10000
    AND adr_minor >= 0
    AND revpar_minor >= 0
  );

--------------------------------------------------------------------------------
-- The standing guard.
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
    AND n.nspname IN ('inventory','property','identity','shared','guests','reservations','folio','reporting')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'Tables carry property_id but have no forced RLS: %. Add ENABLE + FORCE ROW LEVEL SECURITY and a tenant policy.',
      unprotected;
  END IF;
END
$$;
