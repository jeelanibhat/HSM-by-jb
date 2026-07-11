/**
 * Dev/CI seed. Two properties on purpose — a single-property seed cannot catch a
 * tenancy bug, because every query trivially "isolates" correctly when there is
 * nothing to leak from.
 *
 * Runs as the OWNER: it must write rows for both properties, which the RLS-bound
 * app role (correctly) cannot do.
 */
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { ROLES } from '@hotelos/domain';
import { roles, userPropertyRoles, users } from '../modules/identity/infra/schema';
import { organizations, properties, taxes } from '../modules/property/infra/schema';

const OWNER_URL =
  process.env['DATABASE_MIGRATION_URL'] ?? 'postgresql://hotelos:hotelos@localhost:5432/hotelos';

// Stable ids so the E2E suite and manual testing can rely on them.
export const SEED = {
  orgId: '00000000-0000-0000-0000-0000000000aa',
  alphaId: '11111111-1111-1111-1111-111111111111',
  betaId: '22222222-2222-2222-2222-222222222222',
  password: 'Password123!',
} as const;

async function main(): Promise<void> {
  const client = postgres(OWNER_URL, { max: 1 });
  const db = drizzle(client);

  try {
    // Roles are global reference data.
    const roleIds = new Map<string, string>();
    for (const code of ROLES) {
      const id = uuidv7();
      await db.insert(roles).values({ id, code }).onConflictDoNothing();
      roleIds.set(code, id);
    }

    // Re-read: onConflictDoNothing means an existing row keeps its original id.
    const existingRoles = await db.select().from(roles);
    for (const r of existingRoles) roleIds.set(r.code, r.id);

    await db
      .insert(organizations)
      .values({ id: SEED.orgId, name: 'Acme Hospitality Group' })
      .onConflictDoNothing();

    await db
      .insert(properties)
      .values([
        {
          id: SEED.alphaId,
          organizationId: SEED.orgId,
          name: 'Hotel Alpha',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
          businessDate: '2026-07-11',
        },
        {
          id: SEED.betaId,
          organizationId: SEED.orgId,
          name: 'Hotel Beta',
          timezone: 'Asia/Kolkata',
          currency: 'INR',
          businessDate: '2026-07-11',
        },
      ])
      .onConflictDoNothing();

    // 12% GST at Alpha, 18% at Beta — different values, so a cross-tenant leak in
    // a tax calculation shows up as a wrong number, not a coincidentally-right one.
    await db
      .insert(taxes)
      .values([
        {
          id: uuidv7(),
          propertyId: SEED.alphaId,
          name: 'GST 12%',
          rateBps: 1200,
          type: 'EXCLUSIVE',
        },
        {
          id: uuidv7(),
          propertyId: SEED.betaId,
          name: 'GST 18%',
          rateBps: 1800,
          type: 'EXCLUSIVE',
        },
      ])
      .onConflictDoNothing();

    const passwordHash = await argon2.hash(SEED.password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    /**
     * `frontdesk` holds a role at Alpha ONLY. That is the fixture the tenancy and
     * RBAC tests lean on: they assert this user cannot touch Beta.
     * `housekeeping` is the fixture for E2E case 6 (cannot reach cashiering).
     */
    const people: Array<{ email: string; name: string; grants: Array<[string, string]> }> = [
      {
        email: 'admin@hotelos.dev',
        name: 'Aisha Admin',
        grants: [
          [SEED.alphaId, 'ADMIN'],
          [SEED.betaId, 'ADMIN'],
        ],
      },
      {
        email: 'manager@hotelos.dev',
        name: 'Manav Manager',
        grants: [[SEED.alphaId, 'MANAGER']],
      },
      {
        email: 'frontdesk@hotelos.dev',
        name: 'Farah Frontdesk',
        grants: [[SEED.alphaId, 'FRONT_DESK']],
      },
      {
        email: 'housekeeping@hotelos.dev',
        name: 'Hari Housekeeping',
        grants: [[SEED.alphaId, 'HOUSEKEEPING']],
      },
      {
        email: 'auditor@hotelos.dev',
        name: 'Anita Auditor',
        grants: [[SEED.alphaId, 'AUDITOR']],
      },
      // Works at Beta only — the mirror image of frontdesk@, so isolation can be
      // asserted from both directions.
      {
        email: 'beta.frontdesk@hotelos.dev',
        name: 'Bela Beta',
        grants: [[SEED.betaId, 'FRONT_DESK']],
      },
    ];

    for (const person of people) {
      const id = uuidv7();
      await db
        .insert(users)
        .values({ id, email: person.email, name: person.name, passwordHash, status: 'ACTIVE' })
        .onConflictDoNothing();

      const [row] = await db.select().from(users).where(eq(users.email, person.email));
      if (!row) continue;

      for (const [propertyId, roleCode] of person.grants) {
        const roleId = roleIds.get(roleCode);
        if (!roleId) throw new Error(`Missing role ${roleCode}`);

        await db
          .insert(userPropertyRoles)
          .values({ userId: row.id, propertyId, roleId })
          .onConflictDoNothing();
      }
    }

    console.warn('Seed complete.');
    console.warn(`  Properties : Hotel Alpha (${SEED.alphaId})`);
    console.warn(`               Hotel Beta  (${SEED.betaId})`);
    console.warn(`  Password   : ${SEED.password}`);
    console.warn('  Users      : admin@ manager@ frontdesk@ housekeeping@ auditor@ (Alpha)');
    console.warn('               beta.frontdesk@ (Beta only)');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
