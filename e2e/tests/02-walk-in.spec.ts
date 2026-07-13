import { BUSINESS_DATE, sellableRooms } from '../support/db';
import { assignRoom, bookThroughUi, expect, frontDesk, guestRow, test } from '../support/fixtures';

/**
 * TDD §8.3, case 2 — "Walk-in with immediate check-in".
 *
 * Someone arrives at the desk with no booking. The clerk books them and checks them
 * in in one go, which is the most time-pressured thing a front desk does.
 */
test('walk-in: book and check in immediately', async ({ asRole, sql }) => {
  const page = await asRole('frontdesk');

  const confirmation = await bookThroughUi(page, {
    firstName: 'Rahul',
    lastName: 'Iyer',
    typeCode: 'DLX',
    // Arrives TODAY (the business date), one night.
    arrival: BUSINESS_DATE,
    departure: '2026-07-12',
  });

  await page.getByRole('button', { name: 'Go to front desk' }).click();
  await page.getByRole('button', { name: /^Arrivals/ }).click();

  const [room] = await sellableRooms(sql, 'DLX', 1);

  await assignRoom(page, 'Rahul Iyer', room!.number);

  await guestRow(page, 'Rahul Iyer').getByRole('button', { name: 'Check in' }).click();
  await expect(page.getByText(/Rahul Iyer checked in/i)).toBeVisible();

  // Checked in, room occupied, and a folio open and ready for charges.
  const [reservation] = await sql`
    SELECT r.status, f.id AS folio_id, f.status AS folio_status
    FROM reservations.reservations r
    LEFT JOIN folio.folios f ON f.reservation_id = r.id
    WHERE r.confirmation_no = ${confirmation}
  `;

  expect(reservation!['status']).toBe('CHECKED_IN');
  expect(reservation!['folio_id']).toBeTruthy();
  expect(reservation!['folio_status']).toBe('OPEN');

  const [dbRoom] = await sql`SELECT status FROM inventory.rooms WHERE id = ${room!.id}`;
  expect(dbRoom!['status']).toBe('OCCUPIED');
});

/**
 * The rule that protects the exclusion constraint: you cannot check a guest in
 * before a physical room exists to put them in. The UI does not even offer the
 * button — it offers the fix instead.
 */
test('check-in is not offered until a room is assigned', async ({ asRole }) => {
  const page = await asRole('frontdesk');

  await bookThroughUi(page, {
    firstName: 'Ananya',
    lastName: 'Bose',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-13',
  });

  await frontDesk(page, 'Arrivals');

  const row = guestRow(page, 'Ananya Bose');

  await expect(row.getByText('unassigned')).toBeVisible();
  await expect(row.getByRole('button', { name: 'Assign room' })).toBeVisible();

  // A button that exists only to fail teaches people to ignore errors.
  await expect(row.getByRole('button', { name: 'Check in' })).toHaveCount(0);
});
