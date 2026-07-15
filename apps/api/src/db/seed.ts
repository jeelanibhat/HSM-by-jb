/**
 * Dev/CI seed. Two properties on purpose — a single-property seed cannot catch a
 * tenancy bug, because every query trivially "isolates" correctly when there is
 * nothing to leak from.
 *
 * Runs as the OWNER: it must write rows for both properties, which the RLS-bound
 * app role (correctly) cannot do.
 */
import * as argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { uuidv7 } from 'uuidv7';
import { addDays, businessDate, ROLES } from '@hotelos/domain';
import { roles, userPropertyRoles, users } from '../modules/identity/infra/schema';
import { organizations, properties, taxes } from '../modules/property/infra/schema';
import { ratePlans, ratePrices, rooms, roomTypes } from '../modules/inventory/infra/schema';
import { menuItems, outlets } from '../modules/pos/infra/schema';

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

    /**
     * 12% GST at Alpha, 18% at Beta — different values, so a cross-tenant leak in a
     * tax calculation shows up as a wrong number rather than a coincidentally-right
     * one.
     *
     * NOTE THE CONFLICT TARGET. `onConflictDoNothing()` with no target is a no-op:
     * it silently inserts a duplicate every time the seed runs. Because every tax
     * row is applied to every charge, three seed runs meant every guest was charged
     * 36% GST. The unique index on (property_id, name) now makes that impossible,
     * and this target makes the seed genuinely re-runnable.
     */
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
      .onConflictDoNothing({ target: [taxes.propertyId, taxes.name] });

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
        email: 'pos@hotelos.dev',
        name: 'Pooja Waiter',
        grants: [[SEED.alphaId, 'POS_OPERATOR']],
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

    // ── Inventory (TDD §4.2) ────────────────────────────────────────────────
    // Only Alpha gets rooms. Beta stays empty on purpose: a tenancy bug in the
    // inventory queries then shows up as Beta seeing rooms it does not own.
    const types = [
      { code: 'STD', name: 'Standard', base: 2, max: 3, priceMinor: 350_000 }, // ₹3,500
      { code: 'DLX', name: 'Deluxe', base: 2, max: 4, priceMinor: 550_000 }, // ₹5,500
      { code: 'SUITE', name: 'Suite', base: 2, max: 4, priceMinor: 950_000 }, // ₹9,500
    ];

    const typeIds = new Map<string, string>();
    for (const t of types) {
      const [existing] = await db
        .select()
        .from(roomTypes)
        .where(and(eq(roomTypes.propertyId, SEED.alphaId), eq(roomTypes.code, t.code)));

      const id = existing?.id ?? uuidv7();
      if (!existing) {
        await db.insert(roomTypes).values({
          id,
          propertyId: SEED.alphaId,
          code: t.code,
          name: t.name,
          baseOccupancy: t.base,
          maxOccupancy: t.max,
        });
      }
      typeIds.set(t.code, id);
    }

    // 30 rooms: floors 1–3, ten per floor. Mixed statuses so the status board and
    // the availability counters have something non-trivial to show.
    const statuses = ['VACANT_CLEAN', 'VACANT_DIRTY', 'VACANT_CLEAN', 'VACANT_CLEAN', 'OOO'];
    for (let floor = 1; floor <= 3; floor++) {
      for (let n = 1; n <= 10; n++) {
        const number = `${floor}${String(n).padStart(2, '0')}`; // 101..110, 201..
        const code = n <= 6 ? 'STD' : n <= 9 ? 'DLX' : 'SUITE';

        const [existing] = await db
          .select()
          .from(rooms)
          .where(and(eq(rooms.propertyId, SEED.alphaId), eq(rooms.number, number)));
        if (existing) continue;

        await db.insert(rooms).values({
          id: uuidv7(),
          propertyId: SEED.alphaId,
          roomTypeId: typeIds.get(code)!,
          number,
          floor: String(floor),
          status: statuses[(floor + n) % statuses.length]!,
        });
      }
    }

    const [existingPlan] = await db
      .select()
      .from(ratePlans)
      .where(and(eq(ratePlans.propertyId, SEED.alphaId), eq(ratePlans.code, 'BAR')));

    const planId = existingPlan?.id ?? uuidv7();
    if (!existingPlan) {
      await db.insert(ratePlans).values({
        id: planId,
        propertyId: SEED.alphaId,
        code: 'BAR',
        name: 'Best Available Rate',
        currency: 'INR',
        mealPlan: 'CP', // with breakfast
      });
    }

    // Price the next 90 days from the seeded business date.
    let cursor = businessDate('2026-07-11');
    const priceRows: Array<typeof ratePrices.$inferInsert> = [];
    for (let i = 0; i < 90; i++) {
      for (const t of types) {
        priceRows.push({
          id: uuidv7(),
          propertyId: SEED.alphaId,
          ratePlanId: planId,
          roomTypeId: typeIds.get(t.code)!,
          date: cursor,
          priceMinor: t.priceMinor,
        });
      }
      cursor = addDays(cursor, 1);
    }

    await db
      .insert(ratePrices)
      .values(priceRows)
      .onConflictDoNothing({
        target: [ratePrices.ratePlanId, ratePrices.roomTypeId, ratePrices.date],
      });

    // ── POS: one outlet and a short menu (Phase 2) ──────────────────────────
    //
    // The charge code is the OUTLET's, not the dish's: a guest's bill reads
    // "Restaurant — ₹1,025", and the revenue report groups by outlet.
    const restaurantId = uuidv7();

    await db
      .insert(outlets)
      .values({
        id: restaurantId,
        propertyId: SEED.alphaId,
        code: 'RESTAURANT',
        name: 'Saffron',
        chargeCode: 'RESTAURANT',
      })
      .onConflictDoNothing({ target: [outlets.propertyId, outlets.code] });

    const [restaurant] = await db
      .select()
      .from(outlets)
      .where(and(eq(outlets.propertyId, SEED.alphaId), eq(outlets.code, 'RESTAURANT')));

    const menu = [
      { code: 'DAL', name: 'Dal Makhani', category: 'Mains', priceMinor: 45_000 },
      { code: 'BIRYANI', name: 'Hyderabadi Biryani', category: 'Mains', priceMinor: 62_500 },
      { code: 'PANEER', name: 'Paneer Tikka', category: 'Starters', priceMinor: 38_000 },
      { code: 'NAAN', name: 'Butter Naan', category: 'Breads', priceMinor: 9_000 },
      { code: 'GULAB', name: 'Gulab Jamun', category: 'Desserts', priceMinor: 18_000 },
      { code: 'LASSI', name: 'Sweet Lassi', category: 'Drinks', priceMinor: 15_000 },
    ];

    await db
      .insert(menuItems)
      .values(
        menu.map((m) => ({
          id: uuidv7(),
          propertyId: SEED.alphaId,
          outletId: restaurant!.id,
          ...m,
        })),
      )
      .onConflictDoNothing({ target: [menuItems.outletId, menuItems.code] });

    console.warn('Seed complete.');
    console.warn('  Inventory  : Hotel Alpha — 3 room types, 30 rooms, BAR plan, 90 days priced');
    console.warn('               Hotel Beta  — deliberately empty (tenancy canary)');
    console.warn('  POS        : Saffron (restaurant), 6 menu items');
    console.warn(`  Properties : Hotel Alpha (${SEED.alphaId})`);
    console.warn(`               Hotel Beta  (${SEED.betaId})`);
    console.warn(`  Password   : ${SEED.password}`);
    console.warn('  Users      : admin@ manager@ frontdesk@ housekeeping@ pos@ auditor@ (Alpha)');
    console.warn('               beta.frontdesk@ (Beta only)');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
