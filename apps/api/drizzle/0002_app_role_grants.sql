-- Grants for the application runtime role (TDD §9).
--
-- The app connects as `hotelos_app`, NOT as the owner/superuser `hotelos`, because
-- superusers bypass Row-Level Security unconditionally — no policy can stop them.
-- This migration gives that role exactly the DML it needs and nothing more:
-- no DDL, no ownership, no BYPASSRLS. So the policies in 0001 actually bind.
--
-- The role itself is created by infra/postgres/init/02-app-role.sql in dev/CI, and
-- provisioned by infrastructure in production. This migration deliberately FAILS
-- if the role is absent rather than inventing one with a guessable password.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotelos_app') THEN
    RAISE EXCEPTION
      'Role hotelos_app does not exist. Provision it before migrating — the app must not run as a superuser, or RLS will not apply.';
  END IF;

  -- A superuser or BYPASSRLS app role would render every policy in 0001 inert.
  -- Fail the migration loudly rather than deploy a silent tenancy hole.
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'hotelos_app' AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION
      'Role hotelos_app has SUPERUSER or BYPASSRLS. RLS would not apply. Refusing to migrate.';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA "shared", "identity", "property" TO hotelos_app;

-- DML only. No CREATE, no ALTER, no DROP — the app cannot change its own schema,
-- and cannot drop the policies that constrain it.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA "shared", "identity", "property" TO hotelos_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "shared", "identity", "property" TO hotelos_app;

GRANT EXECUTE ON FUNCTION shared.current_property_id() TO hotelos_app;

-- Tables created by future migrations must be reachable too, without anyone having
-- to remember to add a GRANT. Applies to objects the owner creates from now on.
ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "shared", "identity", "property"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "shared", "identity", "property"
  GRANT USAGE, SELECT ON SEQUENCES TO hotelos_app;

-- The audit log is append-only (TDD §2 principle 4). RLS already denies UPDATE and
-- DELETE by having no policy for them; revoking the privilege as well means an
-- attacker would need BOTH a policy bypass and a privilege escalation to rewrite
-- financial history.
REVOKE UPDATE, DELETE ON "shared"."audit_log" FROM hotelos_app;
