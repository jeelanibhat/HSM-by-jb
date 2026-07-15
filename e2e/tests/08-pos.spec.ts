import { ALPHA, BUSINESS_DATE, sellableRooms } from '../support/db';
import {
  alertText,
  assignRoom,
  bookThroughUi,
  expect,
  frontDesk,
  guestRow,
  nav,
  test,
} from '../support/fixtures';

/**
 * Phase 2 — POS.
 *
 * A meal becomes money the guest owes. Everything here is about that one step: it
 * must land on the RIGHT bill, exactly ONCE, with the tax the hotel actually charges —
 * and the waiter must not learn anything about the guest's money on the way.
 */

/** Check a guest in, so there is somebody to charge. */
async function checkedInGuest(
  page: import('@playwright/test').Page,
  sql: import('postgres').Sql,
  last: string,
) {
  const [room] = await sellableRooms(sql, 'STD', 1);

  await bookThroughUi(page, {
    firstName: 'Hungry',
    lastName: last,
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-14',
  });

  await frontDesk(page, 'Arrivals');
  await assignRoom(page, `Hungry ${last}`, room!.number);
  await guestRow(page, `Hungry ${last}`).getByRole('button', { name: 'Check in' }).click();
  await expect(page.getByText(new RegExp(`Hungry ${last} checked in`, 'i'))).toBeVisible();

  return room!;
}

test('a waiter sends a meal to a room, and it lands on the bill with GST', async ({
  asRole,
  sql,
}) => {
  const desk = await asRole('frontdesk');
  const room = await checkedInGuest(desk, sql, 'Sharma');

  // ── The waiter takes an order ──────────────────────────────────────────────
  const waiter = await asRole('pos');
  await waiter.goto('/pos');

  await waiter.getByRole('button', { name: 'New order' }).click();
  await expect(alertText(waiter)).toContainText(/Order R-\d+ opened/);

  await waiter.getByRole('button', { name: /Dal Makhani/ }).click();
  await waiter.getByRole('button', { name: /Butter Naan/ }).click();
  await waiter.getByRole('button', { name: /Butter Naan/ }).click();

  // ₹450 + 2 × ₹90 = ₹630. The CLIENT did not compute that — it never saw a price it
  // could have got wrong.
  await expect(waiter.getByText('₹630.00')).toBeVisible();

  // ── ...and sends it to the room ────────────────────────────────────────────
  //
  // The waiter picks from a list of people who are actually staying. A name and a room
  // number — nothing about what anyone owes.
  const roomButton = waiter.getByRole('button', { name: new RegExp(`${room.number}.*Hungry Sharma`) });
  await expect(roomButton).toBeVisible();

  await roomButton.click();
  await expect(alertText(waiter)).toContainText(new RegExp(`charged to room ${room.number}`, 'i'));

  // ── The truth underneath: it is on the guest's folio, taxed ────────────────
  const lines = await sql`
    SELECT l.code, l.type, l.description, l.amount_minor
    FROM folio.folio_lines l
    WHERE l.property_id = ${ALPHA}
    ORDER BY l.type
  `;

  const charge = lines.find((l) => l['type'] === 'CHARGE');
  expect(charge, 'the meal never reached the guest’s bill').toBeTruthy();
  expect(charge!['code']).toBe('RESTAURANT');
  expect(Number(charge!['amount_minor'])).toBe(63_000);

  // The GST is the FOLIO's, from the property's configuration — the POS has no opinion
  // about tax, which is why there is only ever one GST rate in this system.
  const tax = lines.find((l) => l['type'] === 'TAX');
  expect(tax, 'the meal was billed with no GST').toBeTruthy();
  expect(Number(tax!['amount_minor'])).toBe(7_560); // 12% of ₹630

  // ── The front desk sees it on the bill at check-out ────────────────────────
  await frontDesk(desk, 'In house');
  await guestRow(desk, 'Hungry Sharma').getByRole('button', { name: 'Folio' }).click();

  await expect(desk.getByText(/Saffron · Order R-\d+/)).toBeVisible({ timeout: 20_000 });
  await expect(desk.getByText('₹705.60').first()).toBeVisible(); // ₹630 + 12% GST

  // ── The order is sealed ────────────────────────────────────────────────────
  const [order] = await sql`SELECT status, charged_subtotal_minor FROM pos.orders`;
  expect(order!['status']).toBe('CHARGED');
  expect(Number(order!['charged_subtotal_minor'])).toBe(63_000);
});

test('an order cannot be sent to a room twice', async ({ asRole, sql }) => {
  const desk = await asRole('frontdesk');
  const room = await checkedInGuest(desk, sql, 'Once');

  const waiter = await asRole('pos');
  await waiter.goto('/pos');

  await waiter.getByRole('button', { name: 'New order' }).click();
  await expect(alertText(waiter)).toContainText(/opened/);
  await waiter.getByRole('button', { name: /Hyderabadi Biryani/ }).click();

  await waiter
    .getByRole('button', { name: new RegExp(`${room.number}.*Hungry Once`) })
    .click();
  await expect(alertText(waiter)).toContainText(/charged to room/i);

  // The charged order leaves the open list entirely — there is nothing left to
  // double-tap. (The server refuses regardless; the state machine has no
  // CHARGED → CHARGED edge. This is the UI not offering a mistake.)
  await expect(waiter.getByRole('button', { name: /^R-\d+/ })).toHaveCount(0);

  const charges = await sql`
    SELECT count(*)::int AS n FROM folio.folio_lines
    WHERE property_id = ${ALPHA} AND type = 'CHARGE'
  `;
  expect(Number(charges[0]!['n']), 'the guest was billed twice for one meal').toBe(1);
});

test('a waiter never sees what a guest owes, and cannot reach cashiering', async ({
  asRole,
  sql,
}) => {
  const desk = await asRole('frontdesk');
  const room = await checkedInGuest(desk, sql, 'Private');

  // Put a big room charge on the bill, so there IS a balance worth leaking.
  await frontDesk(desk, 'In house');
  await guestRow(desk, 'Hungry Private').getByRole('button', { name: 'Folio' }).click();
  await desk.getByRole('button', { name: 'Post charge' }).click();
  await desk.getByPlaceholder('e.g. Dinner, table 4').fill('Spa');
  await desk.getByPlaceholder('0.00').fill('9999.00');
  await desk.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(desk.getByText('₹11,198.88').first()).toBeVisible({ timeout: 15_000 });

  const waiter = await asRole('pos');
  await waiter.goto('/pos');

  // Get to the point where a waiter would be looking at the guest list at all — the
  // rooms are offered on an open order, because that is the only moment you need them.
  await waiter.getByRole('button', { name: 'New order' }).click();
  await expect(alertText(waiter)).toContainText(/opened/);
  await waiter.getByRole('button', { name: /Sweet Lassi/ }).click();

  // The room list gives the waiter a NAME. Not a balance.
  const roomButton = waiter.getByRole('button', {
    name: new RegExp(`${room.number}.*Hungry Private`),
  });
  await expect(roomButton).toBeVisible();

  const till = await waiter.locator('body').innerText();
  expect(till, 'the till is showing a guest’s balance to a waiter').not.toContain('11,198');
  expect(till).not.toContain('9,999');

  // The navigation does not offer cashiering, reports, or the night audit...
  await expect(nav(waiter).getByRole('link', { name: 'Point of sale' })).toBeVisible();
  await expect(nav(waiter).getByRole('link', { name: 'Reports' })).toHaveCount(0);
  await expect(nav(waiter).getByRole('link', { name: 'Night audit' })).toHaveCount(0);
  await expect(nav(waiter).getByRole('link', { name: 'New booking' })).toHaveCount(0);

  // ...and the server refuses anyway, which is the part that matters.
  await waiter.goto('/reports');
  await expect(waiter.getByText(/only a manager|not permitted|cannot|permission/i).first()).toBeVisible({
    timeout: 20_000,
  });
});
