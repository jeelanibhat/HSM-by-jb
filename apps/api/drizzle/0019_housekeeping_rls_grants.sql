-- Grants, RLS and value constraints for the new `housekeeping` schema.
--
-- drizzle-kit generates the table. It does not generate any of this, and none of it
-- is inherited: migration 0002 set default privileges for shared/identity/property
-- only, so a brand-new schema starts unreachable by the app role — and if we granted
-- access without adding policies, every hotel's housekeeping board would be visible
-- to every other hotel.
--
-- Both halves are required. Access without policies is a data leak; policies without
-- access is a 500.

GRANT USAGE ON SCHEMA "housekeeping" TO hotelos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "housekeeping" TO hotelos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "housekeeping" TO hotelos_app;

-- Tables added to this schema later must be reachable without anyone remembering.
ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "housekeeping"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "housekeeping"
  GRANT USAGE, SELECT ON SEQUENCES TO hotelos_app;
--> statement-breakpoint

-- FORCE as well as ENABLE: ENABLE alone still lets the TABLE OWNER bypass the policy,
-- and migrations run as the owner. (Neither defeats a SUPERUSER — which is why the
-- app connects as hotelos_app and the API refuses to boot if it does not.)
ALTER TABLE "housekeeping"."tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "housekeeping"."tasks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_isolation ON "housekeeping"."tasks"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());
--> statement-breakpoint

-- The enums live in @hotelos/domain, but the database is the last line: a bad
-- deploy, a script, or a future module must not be able to write a status the state
-- machine has never heard of. A row with status 'CLEANED' would simply be invisible
-- to every query the board makes, and nobody would clean that room.
ALTER TABLE "housekeeping"."tasks"
  ADD CONSTRAINT hk_tasks_type_valid
  CHECK (type IN ('DEPARTURE', 'STAYOVER', 'DEEP_CLEAN', 'TURNDOWN'));
--> statement-breakpoint

ALTER TABLE "housekeeping"."tasks"
  ADD CONSTRAINT hk_tasks_status_valid
  CHECK (status IN ('PENDING', 'IN_PROGRESS', 'DONE', 'INSPECTED'));
--> statement-breakpoint

-- An INSPECTED task without an inspector is a signature nobody signed. Financial and
-- safety audits both ask "who said this room was fit to sell?" — the row must answer.
ALTER TABLE "housekeeping"."tasks"
  ADD CONSTRAINT hk_tasks_inspected_has_inspector
  CHECK (status <> 'INSPECTED' OR (inspected_by IS NOT NULL AND inspected_at IS NOT NULL));
