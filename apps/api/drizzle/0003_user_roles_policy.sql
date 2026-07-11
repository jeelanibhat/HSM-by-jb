-- Fix: login could not read a user's own roles.
--
-- 0001 put identity.user_property_roles under property-RLS. But the auth flow has a
-- chicken-and-egg problem: to know which properties a user may access, we must read
-- their grants — and at that moment there IS no property context to set. The policy
-- correctly failed closed and returned zero rows, so every user logged in with no
-- roles and was then denied access to every property.
--
-- Property is the wrong axis for this table on its own. A row is legitimately
-- visible in two situations:
--
--   1. It belongs to the property being operated on  (admin: "who works here?")
--   2. It belongs to the user doing the asking       (login: "where can I work?")
--
-- So we add a second GUC, app.user_id, and make the policy a disjunction. Both
-- axes still fail closed when their GUC is unset, so an unscoped connection sees
-- nothing — the defence-in-depth property from §2.2 is preserved.

CREATE OR REPLACE FUNCTION shared.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION shared.current_user_id() TO hotelos_app;

DROP POLICY IF EXISTS tenant_isolation ON "identity"."user_property_roles";

CREATE POLICY role_visibility ON "identity"."user_property_roles"
  FOR SELECT
  USING (
    property_id = shared.current_property_id()
    OR user_id = shared.current_user_id()
  );

-- WRITES stay strictly property-scoped. A user must never be able to grant
-- themselves a role — only an admin acting within a property may, and that path
-- always has app.property_id set. Reading your own grants is safe; minting them is not.
CREATE POLICY role_grant ON "identity"."user_property_roles"
  FOR INSERT
  WITH CHECK (property_id = shared.current_property_id());

CREATE POLICY role_revoke ON "identity"."user_property_roles"
  FOR DELETE
  USING (property_id = shared.current_property_id());
