import { ALPHA, BUSINESS_DATE, sellableRooms } from '../support/db';
import { bookThroughUi, expect, frontDesk, guestRow, test } from '../support/fixtures';

/**
 * TDD §8.3, case 1 — THE critical path.
 *
 * "Create reservation → assign room → check-in → post charge → post payment →
 *  check-out → verify folio settled"
 *
 * The whole business, driven through the real screens a receptionist uses.
 */
test('create → assign → check-in → charge → pay → check-out → folio settled', async ({
  asRole,
  sql,
}) => {
  const page = await asRole('frontdesk');

  // ── Book ──────────────────────────────────────────────────────────────────
  const confirmation = await bookThroughUi(page, {
    firstName: 'Priya',
    lastName: 'Sharma',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-14',
  });

  expect(confirmation).toMatch(/^HTL-\d+$/);

  // A room TYPE was sold, not a room. The screen has to say so — a clerk who assumes
  // a room was assigned will not find out until the guest is standing in front of them.
  await expect(page.getByText(/A room type has been held/i)).toBeVisible();

  // ── Assign a room ─────────────────────────────────────────────────────────
  await frontDesk(page, 'Arrivals');

  const row = guestRow(page, 'Priya Sharma');
  await expect(row.getByText('unassigned')).toBeVisible();

  await row.getByRole('button', { name: 'Assign room' }).click();

  const [room] = await sellableRooms(sql, 'STD', 1);
  await page.getByRole('button', { name: room!.number, exact: true }).click();

  await expect(guestRow(page, 'Priya Sharma').getByText(room!.number)).toBeVisible();

  // ── Check in ──────────────────────────────────────────────────────────────
  await guestRow(page, 'Priya Sharma').getByRole('button', { name: 'Check in' }).click();
  await expect(page.getByText(`Priya Sharma checked in to room ${room!.number}`)).toBeVisible();

  const [dbRoom] = await sql`SELECT status FROM inventory.rooms WHERE id = ${room!.id}`;
  expect(dbRoom!['status']).toBe('OCCUPIED');

  // ── Post a charge ─────────────────────────────────────────────────────────
  await frontDesk(page, 'In house');
  await guestRow(page, 'Priya Sharma').getByRole('button', { name: 'Folio' }).click();

  // The folio drawer is open once its posting controls are there. ("Balance" alone is
  // ambiguous — the board has a Balance column too.)
  await expect(page.getByRole('button', { name: 'Post charge' })).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole('button', { name: 'Post charge' }).click();
  await page.getByPlaceholder('e.g. Dinner, table 4').fill('Room · 3 nights');
  await page.getByPlaceholder('0.00').fill('3500.00');
  await page.locator('input[inputmode="numeric"]').fill('3');
  await page.getByRole('button', { name: 'Post', exact: true }).click();

  // ₹10,500 + 12% GST = ₹11,760. The CLIENT did not compute that — the server did.
  await expect(page.getByText('₹11,760.00').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/cannot check out until this is settled/i)).toBeVisible();

  // ── Take payment ──────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Post payment' }).click();
  await page.getByRole('button', { name: /Settle in full/ }).click();
  await page.getByRole('button', { name: 'Take', exact: true }).click();

  await expect(page.getByText(/Settled\. The guest can check out\./i)).toBeVisible({
    timeout: 15_000,
  });

  // ── Check out ─────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Close' }).click();

  await frontDesk(page, 'In house');
  await guestRow(page, 'Priya Sharma').getByRole('button', { name: 'Check out' }).click();

  await expect(page.getByText(/Priya Sharma checked out/i)).toBeVisible();

  // ── Verify the truth underneath ───────────────────────────────────────────
  const [reservation] = await sql`
    SELECT status FROM reservations.reservations WHERE confirmation_no = ${confirmation}
  `;
  expect(reservation!['status']).toBe('CHECKED_OUT');

  const [settled] = await sql`
    SELECT f.status, COALESCE(SUM(l.amount_minor), 0)::int AS balance
    FROM folio.folios f
    LEFT JOIN folio.folio_lines l ON l.folio_id = f.id
    WHERE f.property_id = ${ALPHA}
    GROUP BY f.id, f.status
  `;
  expect(settled!['status']).toBe('SETTLED');
  expect(Number(settled!['balance'])).toBe(0);

  // The room is DIRTY, not clean — nobody has cleaned it yet.
  const [after] = await sql`SELECT status FROM inventory.rooms WHERE id = ${room!.id}`;
  expect(after!['status']).toBe('VACANT_DIRTY');
});
