-- Row-Level Security: tenancy defence-in-depth (TDD §2.2).
--
-- The app already scopes every query by property_id. This layer is what saves us
-- when someone forgets a WHERE clause: instead of leaking another hotel's guests,
-- the query returns zero rows.
--
-- THE TRAP: in Postgres, the table OWNER bypasses RLS entirely. `ENABLE ROW LEVEL
-- SECURITY` alone is decorative for us, because the app connects as `hotelos`,
-- which owns these tables. FORCE is what makes it apply to the owner too.
-- Every table below therefore gets ENABLE *and* FORCE.
--
-- The GUC is set per-transaction by TenantTransaction.run() via
-- `set_config('app.property_id', $1, true)` — the `true` makes it transaction-local,
-- so it cannot bleed into the next caller that borrows this pooled connection.

-- current_setting(..., true) returns NULL instead of raising when the GUC is unset.
-- NULL = property_id evaluates to NULL, which is not TRUE, so the row is filtered
-- out. An unscoped query therefore sees NOTHING — it fails closed, not open.
CREATE OR REPLACE FUNCTION shared.current_property_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.property_id', true), '')::uuid $$;

--------------------------------------------------------------------------------
-- property.properties — the tenant root. Its own id IS the property_id.
--------------------------------------------------------------------------------
ALTER TABLE "property"."properties" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "property"."properties" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "property"."properties"
  USING (id = shared.current_property_id());

--------------------------------------------------------------------------------
-- property.taxes
--------------------------------------------------------------------------------
ALTER TABLE "property"."taxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "property"."taxes" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "property"."taxes"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

--------------------------------------------------------------------------------
-- identity.user_property_roles — a user's grants at THIS property.
--------------------------------------------------------------------------------
ALTER TABLE "identity"."user_property_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "identity"."user_property_roles" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "identity"."user_property_roles"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

--------------------------------------------------------------------------------
-- shared.audit_log — append-only. There is deliberately NO policy for UPDATE or
-- DELETE. Under FORCE RLS, a command with no permissive policy matches zero rows,
-- so even a compromised app connection cannot rewrite or erase history.
--------------------------------------------------------------------------------
ALTER TABLE "shared"."audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_read ON "shared"."audit_log"
  FOR SELECT USING (property_id = shared.current_property_id());

CREATE POLICY tenant_append ON "shared"."audit_log"
  FOR INSERT WITH CHECK (property_id = shared.current_property_id());

--------------------------------------------------------------------------------
-- shared.night_audit_runs
--------------------------------------------------------------------------------
ALTER TABLE "shared"."night_audit_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared"."night_audit_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "shared"."night_audit_runs"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

--------------------------------------------------------------------------------
-- Deliberately NOT under RLS, and why:
--
--   identity.users        Login happens before we know the property — a user may
--                         hold roles at several. Scoped by email/id, never tenant.
--   identity.roles        Global reference data (ADMIN, FRONT_DESK, ...).
--   shared.outbox_events  The relay is a cross-tenant system process and must
--                         drain events for every property. It goes through
--                         TenantTransaction.runWithoutTenantScope().
--------------------------------------------------------------------------------

-- Night audit idempotency at the DB level (TDD §6): one non-failed run per
-- property per business date. Enforced here rather than trusting the application
-- not to double-run it.
CREATE UNIQUE INDEX night_audit_one_run_per_date
  ON "shared"."night_audit_runs" (property_id, business_date)
  WHERE status <> 'FAILED';
