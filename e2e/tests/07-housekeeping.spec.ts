import { ALPHA, BUSINESS_DATE, sellableRooms } from '../support/db';
import { alertText, assignRoom, bookThroughUi, expect, frontDesk, guestRow, nav, test } from '../support/fixtures';

/**
 * Phase 2 — housekeeping.
 *
 * The loop a room actually lives in: a guest leaves, the room is dirty, somebody
 * cleans it, and somebody CHECKS. The last step is the one that matters, and the one
 * this spec spends most of its time on.
 */

/**
 * The card for a room on the board, by its accessible name.
 *
 * Not "the first div whose text happens to start with 204" — that matches whatever
 * the DOM looks like today and silently matches the wrong thing tomorrow.
 */
function roomCard(page: import('@playwright/test').Page, number: string) {
  return page.getByRole('group', { name: `Room ${number}` });
}

async function roomStatus(sql: import('postgres').Sql, roomId: string): Promise<string> {
  const [row] = await sql`SELECT status FROM inventory.rooms WHERE id = ${roomId}`;
  return row!['status'] as string;
}

/** Check a guest in and straight back out, leaving the room dirty — the normal morning. */
async function guestCheckedOut(
  page: import('@playwright/test').Page,
  sql: import('postgres').Sql,
) {
  const [room] = await sellableRooms(sql, 'STD', 1);

  await bookThroughUi(page, {
    firstName: 'Departing',
    lastName: 'Guest',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-12',
  });

  await frontDesk(page, 'Arrivals');
  await assignRoom(page, 'Departing Guest', room!.number);
  await guestRow(page, 'Departing Guest').getByRole('button', { name: 'Check in' }).click();
  await expect(page.getByText(/Departing Guest checked in/i)).toBeVisible();

  await frontDesk(page, 'In house');
  await guestRow(page, 'Departing Guest').getByRole('button', { name: 'Check out' }).click();
  await expect(page.getByText(/Departing Guest checked out/i)).toBeVisible();

  // Dirty, not clean. Nobody has been in there yet.
  expect(await roomStatus(sql, room!.id)).toBe('VACANT_DIRTY');

  return room!;
}

test('a room is cleaned, inspected, and only then sellable', async ({ asRole, sql }) => {
  const desk = await asRole('frontdesk');
  const room = await guestCheckedOut(desk, sql);

  // ── The supervisor builds the morning's board ──────────────────────────────
  const manager = await asRole('manager');
  await manager.goto('/housekeeping');

  await manager.getByRole('button', { name: /Generate today’s board/ }).click();
  await expect(alertText(manager)).toContainText(/Raised \d+ task/);

  const card = roomCard(manager, room.number);
  await expect(card).toContainText('To do');
  await expect(card).toContainText('Departure');

  // ── The attendant cleans it ────────────────────────────────────────────────
  const hk = await asRole('housekeeping');
  await hk.goto('/housekeeping');

  const hkCard = roomCard(hk, room.number);
  await hkCard.getByRole('button', { name: 'Start' }).click();
  await expect(roomCard(hk, room.number)).toContainText('Cleaning');

  await roomCard(hk, room.number).getByRole('button', { name: 'Mark clean' }).click();
  await expect(alertText(hk)).toContainText(`Room ${room.number} cleaned`);

  // The task and the room move together — same transaction.
  expect(await roomStatus(sql, room.id)).toBe('VACANT_CLEAN');

  // "Cleaned" is the attendant's word for it. Not "inspected".
  await expect(roomCard(hk, room.number)).toContainText('Cleaned');

  // ── The attendant cannot sign off their own work ───────────────────────────
  await expect(
    roomCard(hk, room.number).getByRole('button', { name: 'Pass' }),
    'housekeeping was offered the inspection button',
  ).toHaveCount(0);

  // ── The supervisor looks — and sends it back ───────────────────────────────
  await manager.reload();
  await roomCard(manager, room.number).getByRole('button', { name: 'Send back' }).click();

  await manager.getByPlaceholder('e.g. Bathroom not touched').fill('Bathroom not touched');
  await manager.getByRole('dialog').getByRole('button', { name: 'Send back' }).click();

  await expect(alertText(manager)).toContainText(/dirty again/i);

  // THE assertion. A room a supervisor judged unfit must not still be marked clean —
  // the next guest would be handed it.
  expect(
    await roomStatus(sql, room.id),
    'a room that FAILED inspection is still sellable — it will be sold dirty',
  ).toBe('VACANT_DIRTY');

  // ...and the work is back on the board, with a reason the attendant can act on.
  await hk.reload();
  await expect(roomCard(hk, room.number)).toContainText('To do');
  await expect(roomCard(hk, room.number)).toContainText('Bathroom not touched');

  // ── Round two ──────────────────────────────────────────────────────────────
  await roomCard(hk, room.number).getByRole('button', { name: 'Mark clean' }).click();
  await expect(alertText(hk)).toContainText(`Room ${room.number} cleaned`);

  await manager.reload();
  await roomCard(manager, room.number).getByRole('button', { name: 'Pass' }).click();
  await expect(alertText(manager)).toContainText(/inspected and ready to sell/i);

  expect(await roomStatus(sql, room.id)).toBe('VACANT_CLEAN');
  await expect(roomCard(manager, room.number)).toContainText('Inspected');

  const [task] = await sql`
    SELECT status, inspected_by, failed_inspections FROM housekeeping.tasks
    WHERE room_id = ${room.id} AND business_date = ${BUSINESS_DATE}
  `;

  expect(task!['status']).toBe('INSPECTED');
  expect(task!['inspected_by'], 'nobody signed for this room').toBeTruthy();
  expect(Number(task!['failed_inspections']), 'the failed inspection was forgotten').toBe(1);
});

test('generating the board twice does not double the morning', async ({ asRole, sql }) => {
  const desk = await asRole('frontdesk');
  await guestCheckedOut(desk, sql);

  const manager = await asRole('manager');
  await manager.goto('/housekeeping');

  await manager.getByRole('button', { name: /Generate today’s board/ }).click();
  await expect(alertText(manager)).toContainText(/Raised \d+ task/);

  const [first] = await sql`SELECT count(*)::int AS n FROM housekeeping.tasks`;

  // A supervisor WILL press this twice. It must be safe.
  await manager.getByRole('button', { name: /Generate today’s board/ }).click();
  await expect(alertText(manager)).toContainText(/already up to date/i);

  const [second] = await sql`SELECT count(*)::int AS n FROM housekeeping.tasks`;
  expect(Number(second!['n']), 'the board was duplicated').toBe(Number(first!['n']));
});

test('the front desk can see the board but cannot sign a room off', async ({ asRole, sql }) => {
  const desk = await asRole('frontdesk');
  const room = await guestCheckedOut(desk, sql);

  const manager = await asRole('manager');
  await manager.goto('/housekeeping');
  await manager.getByRole('button', { name: /Generate today’s board/ }).click();
  await expect(alertText(manager)).toContainText(/Raised/);

  const hk = await asRole('housekeeping');
  await hk.goto('/housekeeping');
  await roomCard(hk, room.number).getByRole('button', { name: 'Mark clean' }).click();
  await expect(alertText(hk)).toContainText('cleaned');

  // The front desk needs to KNOW which rooms are ready — they hand out the keys.
  await desk.goto('/housekeeping');
  await expect(nav(desk).getByRole('link', { name: 'Housekeeping' })).toBeVisible();
  await expect(roomCard(desk, room.number)).toContainText('Cleaned');

  // But they have every incentive to pass a room they are about to sell, so they
  // are not offered the button — and the server refuses them anyway.
  await expect(
    roomCard(desk, room.number).getByRole('button', { name: 'Pass' }),
    'the front desk was offered the inspection button',
  ).toHaveCount(0);
});
