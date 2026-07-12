-- CONTRACT step of expand → migrate → contract (TDD §10).
--
-- 0010 added the encrypted columns (expand). Nothing has read or written the old
-- plaintext `id_number` since. This drops it.
--
-- The DROP is irreversible and takes real guest ID numbers with it, so it refuses
-- to run on a database where the backfill never finished. A contract migration that
-- destroys un-migrated data is not a migration, it is an incident.
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM guests.guests WHERE id_number IS NOT NULL;

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop guests.id_number: % row(s) still hold plaintext. Run the backfill to encrypt them first — dropping now would destroy them.',
      remaining;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "guests"."guests" DROP COLUMN "id_number";
