-- Folio: grants, RLS, and the immutability of the ledger (TDD §4.4, §6, §9).

--------------------------------------------------------------------------------
-- Grants. A new schema inherits nothing from earlier ALTER DEFAULT PRIVILEGES.
--------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA "folio" TO hotelos_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "folio" TO hotelos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "folio" TO hotelos_app;

ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "folio"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hotelos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hotelos IN SCHEMA "folio"
  GRANT USAGE, SELECT ON SEQUENCES TO hotelos_app;

--------------------------------------------------------------------------------
-- Tenant isolation.
--------------------------------------------------------------------------------
ALTER TABLE "folio"."folios"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folio"."folios"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "folio"."folio_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folio"."folio_lines" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "folio"."invoices"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "folio"."invoices"    FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "folio"."folios"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

CREATE POLICY tenant_isolation ON "folio"."invoices"
  USING (property_id = shared.current_property_id())
  WITH CHECK (property_id = shared.current_property_id());

--------------------------------------------------------------------------------
-- THE LEDGER IS APPEND-ONLY.
--
-- TDD §4.4: "lines are immutable: corrections are reversing entries, never updates".
--
-- This is not a coding convention we all promise to honour. It is enforced twice,
-- because financial history that CAN be quietly rewritten is financial history no
-- auditor will accept:
--
--   1. RLS: policies for SELECT and INSERT only. Under FORCE RLS, a command with
--      no permissive policy matches zero rows, so UPDATE and DELETE silently
--      affect nothing.
--   2. REVOKE: the privilege is taken away outright, so the same statements fail
--      loudly with "permission denied" instead of quietly updating nothing.
--
-- An attacker (or a well-meaning developer with a hotfix script) would need BOTH a
-- policy bypass AND a privilege escalation to alter a posted charge.
--
-- Same treatment as shared.audit_log, and for the same reason.
--------------------------------------------------------------------------------
CREATE POLICY tenant_read ON "folio"."folio_lines"
  FOR SELECT USING (property_id = shared.current_property_id());

CREATE POLICY tenant_append ON "folio"."folio_lines"
  FOR INSERT WITH CHECK (property_id = shared.current_property_id());

-- Deliberately NO policy for UPDATE or DELETE.

REVOKE UPDATE, DELETE ON "folio"."folio_lines" FROM hotelos_app;

-- Invoices are issued documents. Once a guest has the PDF, the numbers are theirs.
REVOKE UPDATE, DELETE ON "folio"."invoices" FROM hotelos_app;

--------------------------------------------------------------------------------
-- Sequences for human-facing numbers.
--------------------------------------------------------------------------------
CREATE SEQUENCE "folio".folio_seq   START 5000;
CREATE SEQUENCE "folio".invoice_seq START 1000;

GRANT USAGE, SELECT ON SEQUENCE "folio".folio_seq   TO hotelos_app;
GRANT USAGE, SELECT ON SEQUENCE "folio".invoice_seq TO hotelos_app;

--------------------------------------------------------------------------------
-- Value constraints.
--------------------------------------------------------------------------------
ALTER TABLE "folio"."folio_lines" ADD CONSTRAINT folio_lines_type_valid
  CHECK (type IN ('CHARGE', 'PAYMENT', 'TAX', 'ADJUSTMENT'));

ALTER TABLE "folio"."folios" ADD CONSTRAINT folios_status_valid
  CHECK (status IN ('OPEN', 'CLOSED', 'SETTLED'));

ALTER TABLE "folio"."folios" ADD CONSTRAINT folios_type_valid
  CHECK (type IN ('GUEST', 'MASTER', 'CITY_LEDGER'));

-- A payment that increases what the guest owes is a bug, not a payment. Sign
-- discipline is what lets the balance be a plain SUM.
ALTER TABLE "folio"."folio_lines" ADD CONSTRAINT folio_lines_payment_is_negative
  CHECK (type <> 'PAYMENT' OR amount_minor <= 0);

-- A reversal must point at a real line, and must not point at itself.
ALTER TABLE "folio"."folio_lines" ADD CONSTRAINT folio_lines_reversal_fk
  FOREIGN KEY (reverses_line_id) REFERENCES "folio"."folio_lines"(id);

ALTER TABLE "folio"."folio_lines" ADD CONSTRAINT folio_lines_no_self_reversal
  CHECK (reverses_line_id IS NULL OR reverses_line_id <> id);

-- One reversal per line. Without this, a double-click on "void" reverses a charge
-- twice and hands the guest free money.
CREATE UNIQUE INDEX folio_lines_one_reversal_per_line
  ON "folio"."folio_lines" (reverses_line_id)
  WHERE reverses_line_id IS NOT NULL;

--------------------------------------------------------------------------------
-- The standing guard: every table carrying property_id has forced RLS.
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
    AND n.nspname IN ('inventory','property','identity','shared','guests','reservations','folio')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION
      'Tables carry property_id but have no forced RLS: %. Add ENABLE + FORCE ROW LEVEL SECURITY and a tenant policy.',
      unprotected;
  END IF;
END
$$;
