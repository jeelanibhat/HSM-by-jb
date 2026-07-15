-- Grants, RLS and value constraints for the new `pos` schema.
--
-- A brand-new schema inherits none of migration 0002's grants or default privileges.
-- Access without policies leaks every hotel's menu, orders and covers to every other
-- hotel; policies without access is a 500 on the first order. Both halves, always.

GRANT USAGE ON SCHEMA "pos" TO hotelos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "pos" TO hotelos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "pos" TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "pos"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "pos"
  GRANT USAGE, SELECT ON SEQUENCES TO hotelos_app;
--> statement-breakpoint

-- ENABLE *and* FORCE on all four: ENABLE alone still lets the table OWNER bypass the
-- policy, and migrations run as the owner.
ALTER TABLE "pos"."outlets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos"."outlets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pos"."outlets"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());
--> statement-breakpoint

ALTER TABLE "pos"."menu_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos"."menu_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pos"."menu_items"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());
--> statement-breakpoint

ALTER TABLE "pos"."orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos"."orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pos"."orders"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());
--> statement-breakpoint

ALTER TABLE "pos"."order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pos"."order_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pos"."order_lines"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());
--> statement-breakpoint

-- The state machine lives in @hotelos/domain, but the database is the last line: a bad
-- deploy or a stray script must not be able to write a status nothing has heard of.
ALTER TABLE "pos"."orders"
  ADD CONSTRAINT pos_orders_status_valid
  CHECK (status IN ('OPEN', 'CHARGED', 'VOID'));
--> statement-breakpoint

-- A CHARGED order must say WHERE it was charged. An order marked charged with no folio
-- is a meal the restaurant believes it billed and the guest will never see — and the
-- row itself cannot tell you which.
ALTER TABLE "pos"."orders"
  ADD CONSTRAINT pos_orders_charged_has_folio
  CHECK (
    status <> 'CHARGED'
    OR (folio_id IS NOT NULL AND charged_at IS NOT NULL AND charged_subtotal_minor IS NOT NULL)
  );
--> statement-breakpoint

-- Selling a negative quantity credits the guest. Selling zero is a line that means
-- nothing. Neither is a thing a waiter should be able to do by mis-keying.
ALTER TABLE "pos"."order_lines"
  ADD CONSTRAINT pos_order_lines_qty_positive
  CHECK (quantity > 0);
--> statement-breakpoint

-- A negative price is a refund pretending to be a sale. Refunds go through the folio,
-- where they are audited.
ALTER TABLE "pos"."order_lines"
  ADD CONSTRAINT pos_order_lines_price_not_negative
  CHECK (unit_price_minor >= 0);
--> statement-breakpoint

ALTER TABLE "pos"."menu_items"
  ADD CONSTRAINT pos_menu_items_price_not_negative
  CHECK (price_minor >= 0);
