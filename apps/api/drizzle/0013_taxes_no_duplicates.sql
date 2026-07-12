-- One tax of a given name per property.
--
-- THIS FIXES A LIVE OVERCHARGING BUG.
--
-- property.taxes had no unique constraint, and every tax row is applied to every
-- charge. So a duplicated 'GST 12%' row charged the guest 24%; a triplicate, 36%.
-- Nothing in the code looked wrong. Nothing in review would have caught it. It
-- surfaces as a letter from a tax authority, months later, about money already
-- collected from guests and not remitted.
--
-- A re-runnable seed created the duplicates (onConflictDoNothing with no conflict
-- target is a no-op). That seed is fixed — but the seed was only ONE way to insert
-- a second row. An admin UI, an import script, or a support engineer with psql
-- would all have done it just as easily. The database is where this has to be
-- stopped.

--------------------------------------------------------------------------------
-- Deduplicate first — the unique index cannot be created over existing dupes.
-- Keep the OLDEST row of each (property, name): it is the one whose id the rest of
-- the system may already be referencing.
--------------------------------------------------------------------------------
DELETE FROM "property"."taxes" t
WHERE t.id NOT IN (
  SELECT DISTINCT ON (property_id, name) id
  FROM "property"."taxes"
  ORDER BY property_id, name, created_at ASC, id ASC
);

ALTER TABLE "property"."taxes"
  ADD CONSTRAINT taxes_property_name_uq UNIQUE (property_id, name);

--------------------------------------------------------------------------------
-- While we are here: a tax rate outside 0–100% is a typo, not a tax. 12% is 1200
-- basis points; someone entering "12" gets 0.12%, and someone entering "1200000"
-- gets 12,000%. Both are silent until a guest reads their bill.
--------------------------------------------------------------------------------
ALTER TABLE "property"."taxes" ADD CONSTRAINT taxes_rate_sane
  CHECK (rate_bps >= 0 AND rate_bps <= 10000);

ALTER TABLE "property"."taxes" ADD CONSTRAINT taxes_type_valid
  CHECK (type IN ('INCLUSIVE', 'EXCLUSIVE'));
