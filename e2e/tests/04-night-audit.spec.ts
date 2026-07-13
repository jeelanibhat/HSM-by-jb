import { ALPHA, BUSINESS_DATE, sellableRooms } from '../support/db';
import { assignRoom, bookThroughUi, expect, frontDesk, guestRow, test } from '../support/fixtures';

/**
 * TDD §8.3, case 4 — "Night audit run → business date advances, room charges posted,
 * no-shows marked".
 */
test('night audit: charges posted, no-shows marked, business date advances', async ({
  asRole,
  sql,
}) => {
  const desk = await asRole('frontdesk');
  const [room] = await sellableRooms(sql, 'STD', 1);

  // An in-house guest who will be charged for the night.
  await bookThroughUi(desk, {
    firstName: 'InHouse',
    lastName: 'Guest',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-14',
  });

  await frontDesk(desk, 'Arrivals');
  await assignRoom(desk, 'InHouse Guest', room!.number);
  await guestRow(desk, 'InHouse Guest').getByRole('button', { name: 'Check in' }).click();
  await expect(desk.getByText(/InHouse Guest checked in/i)).toBeVisible();

  // ...and a confirmed booking that never turns up.
  const noShow = await bookThroughUi(desk, {
    firstName: 'Never',
    lastName: 'Arrived',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-13',
  });

  const [before] = await sql`
    SELECT sold FROM reservations.room_type_availability a
    JOIN inventory.room_types t ON t.id = a.room_type_id
    WHERE a.property_id = ${ALPHA} AND t.code = 'STD' AND a.date = ${BUSINESS_DATE}
  `;
  expect(Number(before!['sold'])).toBe(2); // both hold inventory

  // ── Run the audit ─────────────────────────────────────────────────────────
  const manager = await asRole('manager');
  await manager.goto('/night-audit');

  await expect(manager.getByRole('main').getByText(BUSINESS_DATE)).toBeVisible({
    timeout: 25_000,
  });
  await manager.getByRole('button', { name: /Run night audit/ }).click();

  await expect(
    manager.getByText(/Audit complete — business date 2026-07-11 → 2026-07-12/),
  ).toBeVisible({ timeout: 45_000 });

  // Every step reported. Scoped to the step ROW — the step name appears both on the <li>
  // and on the <span> inside it, so a bare getByText is ambiguous.
  const step = (name: string) => manager.getByRole('listitem').filter({ hasText: name });

  await expect(step('Post room & tax charges')).toBeVisible();
  await expect(step('Mark no-shows, release rooms')).toBeVisible();
  await expect(step('Freeze occupancy, ADR, RevPAR')).toBeVisible();
  await expect(step('Advance the business date')).toBeVisible();

  // ── The room charge landed, on the AUDIT date ─────────────────────────────
  const lines = await sql`
    SELECT l.code, l.amount_minor, l.business_date
    FROM folio.folio_lines l
    WHERE l.property_id = ${ALPHA}
    ORDER BY l.code
  `;

  const roomCharge = lines.find((l) => l['code'] === 'ROOM');
  expect(roomCharge, 'the in-house guest was not charged for the night').toBeTruthy();
  expect(Number(roomCharge!['amount_minor'])).toBe(350_000);
  // Posted against the trading day that just closed, not the calendar date.
  expect(roomCharge!['business_date']).toBe(BUSINESS_DATE);

  const tax = lines.find((l) => l['code'] === 'TAX');
  expect(Number(tax!['amount_minor'])).toBe(42_000); // GST 12%

  // ── The no-show was marked, and RELEASED its room ─────────────────────────
  const [gone] = await sql`
    SELECT status FROM reservations.reservations WHERE confirmation_no = ${noShow}
  `;
  expect(gone!['status']).toBe('NO_SHOW');

  const [after] = await sql`
    SELECT sold FROM reservations.room_type_availability a
    JOIN inventory.room_types t ON t.id = a.room_type_id
    WHERE a.property_id = ${ALPHA} AND t.code = 'STD' AND a.date = ${BUSINESS_DATE}
  `;
  // A no-show that kept its room would quietly shrink the hotel by one room a night,
  // forever.
  expect(Number(after!['sold']), 'no-show inventory was never released').toBe(1);

  // ── The business date moved ───────────────────────────────────────────────
  const [property] = await sql`SELECT business_date FROM property.properties WHERE id = ${ALPHA}`;
  expect(property!['business_date']).toBe('2026-07-12');

  // The front desk now shows the NEW trading day.
  await desk.goto('/front-desk');
  await expect(desk.getByRole('banner').getByText('2026-07-12')).toBeVisible({ timeout: 25_000 });

  // ── And the numbers were frozen ───────────────────────────────────────────
  await manager.goto('/reports');
  await manager.locator('input[type="date"]').first().fill(BUSINESS_DATE);

  await expect(manager.getByText('ADR')).toBeVisible({ timeout: 20_000 });
  await expect(manager.getByText('₹3,500.00').first()).toBeVisible();
});

/**
 * §8.2: "idempotency (re-running a step is a no-op)". The 3am case: an operator
 * re-runs a failed audit and must not charge every guest a second time.
 */
test('re-running the audit does NOT charge the guest twice', async ({ asRole, sql }) => {
  const desk = await asRole('frontdesk');
  const [room] = await sellableRooms(sql, 'STD', 1);

  await bookThroughUi(desk, {
    firstName: 'Twice',
    lastName: 'Charged',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-14',
  });

  await frontDesk(desk, 'Arrivals');
  await assignRoom(desk, 'Twice Charged', room!.number);
  await guestRow(desk, 'Twice Charged').getByRole('button', { name: 'Check in' }).click();
  await expect(desk.getByText(/Twice Charged checked in/i)).toBeVisible();

  const manager = await asRole('manager');
  await manager.goto('/night-audit');
  await manager.getByRole('button', { name: /Run night audit/ }).click();
  await expect(manager.getByText(/Audit complete/)).toBeVisible({ timeout: 45_000 });

  const [first] = await sql`
    SELECT COALESCE(SUM(amount_minor), 0)::int AS balance
    FROM folio.folio_lines WHERE property_id = ${ALPHA}
  `;
  expect(Number(first!['balance'])).toBe(392_000);

  // Wind the hotel back to the audit night and mark the run failed — exactly the
  // state an operator finds after a crash mid-audit.
  await sql`UPDATE property.properties SET business_date = ${BUSINESS_DATE} WHERE id = ${ALPHA}`;
  await sql`UPDATE shared.night_audit_runs SET status = 'FAILED' WHERE property_id = ${ALPHA}`;

  await manager.reload();
  await expect(manager.getByText(/failed part-way/i)).toBeVisible();
  await manager.getByRole('button', { name: /Resume night audit/ }).click();
  await expect(manager.getByText(/Audit complete/)).toBeVisible({ timeout: 45_000 });

  const [second] = await sql`
    SELECT COALESCE(SUM(amount_minor), 0)::int AS balance
    FROM folio.folio_lines WHERE property_id = ${ALPHA}
  `;

  // The unique index refused the second insert. The guest pays for one night.
  expect(Number(second!['balance']), 'the guest was charged twice for the same night').toBe(
    Number(first!['balance']),
  );

  const [rooms] = await sql`
    SELECT count(*)::int AS n FROM folio.folio_lines
    WHERE property_id = ${ALPHA} AND code = 'ROOM'
  `;
  expect(Number(rooms!['n'])).toBe(1);
});
