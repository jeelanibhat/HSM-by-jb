import { BUSINESS_DATE, sellableRooms } from '../support/db';
import { bookThroughUi, expect, frontDesk, guestRow, nav, test } from '../support/fixtures';

/**
 * TDD §8.3, case 6 — "RBAC: housekeeping role cannot access cashiering".
 *
 * The API refuses regardless. What is asserted here is that the SCREEN does not dangle
 * the option in front of someone who will only ever be refused — a menu item that
 * always errors is how people learn to ignore error messages.
 */
test('housekeeping cannot reach cashiering, and is not offered it', async ({ asRole, sql }) => {
  // Arrange: a guest with a bill, put there by the front desk.
  const desk = await asRole('frontdesk');
  const [room] = await sellableRooms(sql, 'STD', 1);

  await bookThroughUi(desk, {
    firstName: 'Billed',
    lastName: 'Guest',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-14',
  });

  await frontDesk(desk, 'Arrivals');
  await guestRow(desk, 'Billed Guest').getByRole('button', { name: 'Assign room' }).click();
  await desk.getByRole('button', { name: room!.number, exact: true }).click();
  await guestRow(desk, 'Billed Guest').getByRole('button', { name: 'Check in' }).click();
  await expect(desk.getByText(/Billed Guest checked in/i)).toBeVisible();

  // ── Housekeeping ──────────────────────────────────────────────────────────
  const hk = await asRole('housekeeping');
  await hk.goto('/dashboard');
  await expect(nav(hk)).toBeVisible({ timeout: 20_000 });

  // The back office is not in their navigation at all.
  await expect(nav(hk).getByRole('link', { name: 'Reports' })).toHaveCount(0);
  await expect(nav(hk).getByRole('link', { name: 'Night audit' })).toHaveCount(0);
  await expect(nav(hk).getByRole('link', { name: 'New booking' })).toHaveCount(0);

  // They CAN see rooms — turning them over is their job.
  await expect(nav(hk).getByRole('link', { name: 'Rooms' })).toBeVisible();

  // And the dashboard shows them no revenue.
  await expect(hk.getByText('Billed today')).toHaveCount(0);
  await expect(hk.getByText('Guests still owe')).toHaveCount(0);

  // ── They cannot work the till ─────────────────────────────────────────────
  await frontDesk(hk, 'In house');
  await expect(guestRow(hk, 'Billed Guest')).toBeVisible();

  // The guest is visible — housekeeping needs to know who is in the building — but
  // there is no folio button and no check-out. Nothing that moves money.
  const row = guestRow(hk, 'Billed Guest');
  await expect(row.getByRole('button', { name: 'Folio' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Check out' })).toHaveCount(0);

  // ── And the server refuses even if they type the URL ───────────────────────
  await hk.goto('/reports');
  await expect(hk.getByText(/insufficient permissions/i)).toBeVisible({ timeout: 20_000 });
});

/**
 * The mirror image: an AUDITOR exists to read the numbers and must be able to — but
 * must not be able to move a single one of them.
 */
test('an auditor reads every report but cannot change anything', async ({ asRole }) => {
  const auditor = await asRole('auditor');

  await auditor.goto('/reports');
  await expect(auditor.getByText('Trial balance')).toBeVisible({ timeout: 25_000 });
  await expect(auditor.getByText(/insufficient permissions/i)).toHaveCount(0);

  // Reports: yes. Closing the books, or selling a room: no.
  await auditor.goto('/dashboard');
  await expect(nav(auditor).getByRole('link', { name: 'Reports' })).toBeVisible();
  await expect(nav(auditor).getByRole('link', { name: 'Night audit' })).toHaveCount(0);
  await expect(nav(auditor).getByRole('link', { name: 'New booking' })).toHaveCount(0);

  // The room board is read-only for them — every tile is disabled.
  await auditor.goto('/rooms');
  await expect(auditor.getByText('Floor 1')).toBeVisible({ timeout: 25_000 });

  const tiles = auditor.locator('button').filter({ hasText: /^\d+/ });
  const count = await tiles.count();

  if (count > 0) {
    await expect(tiles.first()).toBeDisabled();
  }
});

/**
 * Front desk sells rooms and takes money, but does not close the books and does not
 * see the hotel's revenue.
 */
test('front desk can take money but cannot see revenue or close the books', async ({ asRole }) => {
  const desk = await asRole('frontdesk');
  await desk.goto('/dashboard');
  await expect(nav(desk)).toBeVisible({ timeout: 20_000 });

  await expect(nav(desk).getByRole('link', { name: 'New booking' })).toBeVisible();
  await expect(nav(desk).getByRole('link', { name: 'Front desk' })).toBeVisible();

  await expect(nav(desk).getByRole('link', { name: 'Reports' })).toHaveCount(0);
  await expect(nav(desk).getByRole('link', { name: 'Night audit' })).toHaveCount(0);

  await desk.goto('/night-audit');
  await expect(desk.getByText(/Only a manager or admin can close the books/i)).toBeVisible({
    timeout: 25_000,
  });
});
