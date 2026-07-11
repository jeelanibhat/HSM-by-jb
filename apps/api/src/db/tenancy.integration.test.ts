/**
 * Row-Level Security — the tenancy regression suite (TDD §2.2, §8.1).
 *
 * These tests exist because RLS was, at one point in this repo's history,
 * completely inert: the app connected as `hotelos`, a SUPERUSER, and superusers
 * bypass RLS unconditionally — `FORCE ROW LEVEL SECURITY` does not stop them.
 * Every policy was decorative and one hotel could read another's data.
 *
 * The lesson: RLS assertions only mean something when made over the UNPRIVILEGED
 * runtime connection. `appClient()` is that connection. Do not "fix" a failure
 * here by pointing it at the owner.
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appClient, ownerClient, truncateAll } from '../test/db';

const ORG = '00000000-0000-0000-0000-0000000000aa';
const ALPHA = '11111111-1111-1111-1111-111111111111';
const BETA = '22222222-2222-2222-2222-222222222222';

let app: postgres.Sql;
let owner: postgres.Sql;

/** Run `fn` in a transaction scoped to `propertyId`, exactly as TenantTransaction does. */
async function asTenant<T>(
  propertyId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`SELECT set_config('app.property_id', ${propertyId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

beforeAll(() => {
  app = appClient();
  owner = ownerClient();
});

afterAll(async () => {
  await app.end();
  await owner.end();
});

beforeEach(async () => {
  await truncateAll(owner);

  await owner`INSERT INTO property.organizations (id, name) VALUES (${ORG}, 'Acme Group')`;
  await owner`
    INSERT INTO property.properties (id, organization_id, name, timezone, currency, business_date)
    VALUES
      (${ALPHA}, ${ORG}, 'Hotel Alpha', 'Asia/Kolkata', 'INR', '2026-07-11'),
      (${BETA},  ${ORG}, 'Hotel Beta',  'Asia/Kolkata', 'INR', '2026-07-11')
  `;
  await owner`
    INSERT INTO property.taxes (id, property_id, name, rate_bps, type)
    VALUES
      (gen_random_uuid(), ${ALPHA}, 'Alpha GST', 1200, 'EXCLUSIVE'),
      (gen_random_uuid(), ${BETA},  'Beta GST',  1800, 'EXCLUSIVE')
  `;
});

describe('the runtime role itself', () => {
  // If this fails, every other assertion in this file is vacuous.
  it('is NOT a superuser and does NOT have BYPASSRLS', async () => {
    const [row] = await app<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;

    expect(row?.rolsuper, 'app role is a superuser — RLS is bypassed entirely').toBe(false);
    expect(row?.rolbypassrls, 'app role has BYPASSRLS — RLS is bypassed entirely').toBe(false);
  });

  it('does not own the tenant tables (owners bypass RLS without FORCE)', async () => {
    const [row] = await app<{ owner: string }[]>`
      SELECT tableowner AS owner FROM pg_tables
      WHERE schemaname = 'property' AND tablename = 'taxes'
    `;
    expect(row?.owner).not.toBe('hotelos_app');
  });

  it('has FORCE row level security on, so even the owner cannot bypass it', async () => {
    const [row] = await owner<{ relforcerowsecurity: boolean; relrowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE oid = 'property.taxes'::regclass
    `;
    expect(row?.relrowsecurity).toBe(true);
    expect(row?.relforcerowsecurity).toBe(true);
  });
});

describe('reads', () => {
  it('returns NOTHING when no tenant is set — fails closed, not open', async () => {
    const rows = await app`SELECT * FROM property.taxes`;
    expect(rows).toHaveLength(0);
  });

  it('shows a property only its own rows', async () => {
    const alpha = await asTenant(ALPHA, (tx) => tx`SELECT name FROM property.taxes`);
    const beta = await asTenant(BETA, (tx) => tx`SELECT name FROM property.taxes`);

    expect(alpha.map((r) => r['name'])).toEqual(['Alpha GST']);
    expect(beta.map((r) => r['name'])).toEqual(['Beta GST']);
  });

  /** The forgotten-WHERE-clause case — the entire reason RLS is here. */
  it('hides another tenant even when the query explicitly asks for them', async () => {
    const rows = await asTenant(
      ALPHA,
      (tx) => tx`SELECT * FROM property.taxes WHERE property_id = ${BETA}`,
    );
    expect(rows).toHaveLength(0);
  });

  it('scopes the properties table to the caller itself', async () => {
    const rows = await asTenant(ALPHA, (tx) => tx`SELECT name FROM property.properties`);
    expect(rows.map((r) => r['name'])).toEqual(['Hotel Alpha']);
  });

  it('does not leak via aggregates', async () => {
    const [row] = await asTenant(
      ALPHA,
      (tx) => tx`SELECT count(*)::int AS n, max(rate_bps)::int AS worst FROM property.taxes`,
    );
    // Beta's 1800 must not surface through max().
    expect(row?.['n']).toBe(1);
    expect(row?.['worst']).toBe(1200);
  });
});

describe('writes', () => {
  it('rejects inserting a row that belongs to another tenant', async () => {
    await expect(
      asTenant(
        ALPHA,
        (tx) => tx`
          INSERT INTO property.taxes (id, property_id, name, rate_bps, type)
          VALUES (gen_random_uuid(), ${BETA}, 'Smuggled', 9999, 'EXCLUSIVE')
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot update another tenant’s row', async () => {
    await asTenant(
      ALPHA,
      (tx) => tx`UPDATE property.taxes SET rate_bps = 1 WHERE property_id = ${BETA}`,
    );

    // Beta's rate is untouched — the UPDATE matched zero rows rather than erroring.
    const [beta] = await asTenant(BETA, (tx) => tx`SELECT rate_bps FROM property.taxes`);
    expect(beta?.['rate_bps']).toBe(1800);
  });

  it('cannot delete another tenant’s row', async () => {
    await asTenant(ALPHA, (tx) => tx`DELETE FROM property.taxes WHERE property_id = ${BETA}`);

    const beta = await asTenant(BETA, (tx) => tx`SELECT 1 FROM property.taxes`);
    expect(beta).toHaveLength(1);
  });
});

describe('audit log is append-only (TDD §6)', () => {
  beforeEach(async () => {
    await owner`
      INSERT INTO shared.audit_log (id, property_id, action, entity_type, entity_id)
      VALUES (gen_random_uuid(), ${ALPHA}, 'reservation.created', 'reservation', gen_random_uuid())
    `;
  });

  it('allows a tenant to append and read its own entries', async () => {
    const rows = await asTenant(ALPHA, (tx) => tx`SELECT action FROM shared.audit_log`);
    expect(rows.map((r) => r['action'])).toEqual(['reservation.created']);
  });

  it('refuses to let the app rewrite history', async () => {
    await expect(
      asTenant(ALPHA, (tx) => tx`UPDATE shared.audit_log SET action = 'tampered'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses to let the app erase history', async () => {
    await expect(
      asTenant(ALPHA, (tx) => tx`DELETE FROM shared.audit_log`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does not show one property another property’s audit trail', async () => {
    const rows = await asTenant(BETA, (tx) => tx`SELECT * FROM shared.audit_log`);
    expect(rows).toHaveLength(0);
  });
});

describe('the app role cannot escalate', () => {
  it('cannot drop the policies that constrain it', async () => {
    await expect(
      app`DROP POLICY tenant_isolation ON property.taxes`,
    ).rejects.toThrow(/must be owner|permission denied/i);
  });

  it('cannot disable row level security', async () => {
    await expect(
      app`ALTER TABLE property.taxes DISABLE ROW LEVEL SECURITY`,
    ).rejects.toThrow(/must be owner|permission denied/i);
  });

  it('cannot create tables (no DDL)', async () => {
    await expect(app`CREATE TABLE property.evil (id uuid)`).rejects.toThrow(/permission denied/i);
  });
});
