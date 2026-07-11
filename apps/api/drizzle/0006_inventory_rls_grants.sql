-- Grants + RLS for the new `inventory` schema.
--
-- EASY TO MISS: migration 0002 granted USAGE and DML on shared/identity/property,
-- and set ALTER DEFAULT PRIVILEGES for those three schemas only. A brand-new
-- schema inherits none of that. Without this file the app role cannot see
-- inventory at all — and if we had only granted access without adding policies,
-- every hotel's rooms and rates would be visible to every other hotel.
--
-- Any future module that introduces a schema needs the same two halves: grants,
-- and policies. The check at the bottom fails the migration if a tenant table is
-- left unprotected, so this cannot be forgotten quietly.

GRANT USAGE ON SCHEMA "inventory" TO hotelos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "inventory" TO hotelos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "inventory" TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "inventory"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "inventory"
  GRANT USAGE, SELECT ON SEQUENCES TO hotelos_app;

--------------------------------------------------------------------------------
-- Tenant isolation. ENABLE *and* FORCE — FORCE is what makes the policy apply to
-- the table owner too (see 0001).
--------------------------------------------------------------------------------
ALTER TABLE "inventory"."room_types"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."room_types"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "inventory"."rooms"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."rooms"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "inventory"."rate_plans"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."rate_plans"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "inventory"."rate_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."rate_prices" FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "inventory"."room_types"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

CREATE POLICY tenant_isolation ON "inventory"."rooms"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

CREATE POLICY tenant_isolation ON "inventory"."rate_plans"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

CREATE POLICY tenant_isolation ON "inventory"."rate_prices"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

--------------------------------------------------------------------------------
-- Room status must be one of the five the domain machine knows about. A typo in
-- an UPDATE would otherwise create a sixth status that no code handles, and the
-- room would quietly fall out of both the availability count and the status board.
--------------------------------------------------------------------------------
ALTER TABLE "inventory"."rooms" ADD CONSTRAINT rooms_status_valid
  CHECK (status IN ('VACANT_CLEAN', 'VACANT_DIRTY', 'OCCUPIED', 'OOO', 'OOS'));

ALTER TABLE "inventory"."room_types" ADD CONSTRAINT room_types_occupancy_sane
  CHECK (max_occupancy >= base_occupancy AND base_occupancy >= 1);

-- A negative room rate is never a real price; it is a bug or an attack.
ALTER TABLE "inventory"."rate_prices" ADD CONSTRAINT rate_prices_non_negative
  CHECK (price_minor >= 0);

--------------------------------------------------------------------------------
-- Guard: every table carrying property_id must have RLS enabled AND forced.
-- This is the check that stops the next module from shipping a tenancy hole
-- because someone added a table and forgot a policy.
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
    AND n.nspname IN ('inventory', 'property', 'identity', 'shared')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'Tables carry property_id but have no forced RLS: %. Add ENABLE + FORCE ROW LEVEL SECURITY and a tenant policy.',
      unprotected;
  END IF;
END
$$;
