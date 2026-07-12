-- Link a TAX line to the CHARGE it taxes.
--
-- FIXES A LIVE OVERCHARGING BUG. Voiding a charge left its tax line behind: the
-- guest kept paying GST on a line that no longer existed, and the hotel would have
-- remitted tax it never collected. The tax is not an independent economic event —
-- it exists only because the charge does, so it must be reversed with it.
--
-- Caught by reading an actual printed ledger, not by a passing test. The unit tests
-- were checking that "a charge and its reversal sum to zero" — which they did. The
-- orphaned tax line was sitting right next to them.

ALTER TABLE "folio"."folio_lines" ADD COLUMN "parent_line_id" uuid;--> statement-breakpoint
CREATE INDEX "folio_lines_parent_idx" ON "folio"."folio_lines" USING btree ("parent_line_id");--> statement-breakpoint

-- A tax line must point at a real charge on the same folio.
ALTER TABLE "folio"."folio_lines" ADD CONSTRAINT folio_lines_parent_fk
  FOREIGN KEY (parent_line_id) REFERENCES "folio"."folio_lines"(id);--> statement-breakpoint

ALTER TABLE "folio"."folio_lines" ADD CONSTRAINT folio_lines_no_self_parent
  CHECK (parent_line_id IS NULL OR parent_line_id <> id);

-- NOTE: drizzle-kit also wanted to add taxes_property_name_uq here. It does not know
-- about hand-written migrations, and 0013 already created that constraint. The
-- statement is omitted deliberately — re-adding it fails.
