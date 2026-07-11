-- Fix: the property switcher ("which hotels can I work at?") returned nothing.
--
-- Same shape of problem as 0003. property.properties was visible only when
-- app.property_id equalled its id — but `myProperties` is asked BEFORE a property
-- is chosen; it is the query that lets the user choose one. With no GUC set, the
-- policy correctly returned zero rows and the switcher was always empty.
--
-- A property is legitimately visible in two situations:
--   1. It is the property currently being operated on  (every scoped request)
--   2. The asking user holds a role at it              (the switcher, at login)
--
-- The second arm is NOT "any authenticated user may list all properties" — it is
-- bounded by that user's own grants, so it reveals nothing about hotels they have
-- no relationship with. Both arms still fail closed when their GUC is unset, so an
-- unscoped connection sees nothing.

DROP POLICY IF EXISTS tenant_isolation ON "property"."properties";

CREATE POLICY property_visibility ON "property"."properties"
  FOR SELECT
  USING (
    id = shared.current_property_id()
    OR id IN (
      SELECT upr.property_id
      FROM "identity"."user_property_roles" upr
      WHERE upr.user_id = shared.current_user_id()
    )
  );

-- Mutations to a property row stay strictly scoped to that property. This is the
-- path night audit takes to advance business_date (TDD §6): it must be impossible
-- to roll another hotel's business date forward.
CREATE POLICY property_write ON "property"."properties"
  FOR UPDATE
  USING (id = shared.current_property_id())
  WITH CHECK (id = shared.current_property_id());
