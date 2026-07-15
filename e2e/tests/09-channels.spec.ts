import { ALPHA, BUSINESS_DATE } from '../support/db';
import { alertText, expect, frontDesk, guestRow, test } from '../support/fixtures';

/**
 * Phase 2 — the channel manager.
 *
 * Two flows, both proven through the screens:
 *
 *   IN  — an OTA delivers a booking; it becomes a real reservation on the front-desk
 *         board, and shows CONFIRMED in the channel's delivery log.
 *   OUT — the current availability is pushed to the channel, where "What SimTrip sees"
 *         reads it back.
 *
 * The API runs the sync relay for real here (it is off only in the unit/integration
 * gate), so the outbound push happens on its own timer — the test waits for it rather
 * than driving it.
 */

test('an OTA booking becomes a reservation on the front desk', async ({ asRole, sql }) => {
  const manager = await asRole('manager');
  await manager.goto('/channels');

  // The seeded channel is connected, enabled, and mapped.
  await expect(manager.getByRole('heading', { name: 'SimTrip', exact: true })).toBeVisible();
  await expect(manager.getByText('Enabled')).toBeVisible();
  await expect(manager.getByText('SIM-STD').first()).toBeVisible();

  // An OTA sells a standard room, arriving today so it lands on the arrivals board.
  await manager.getByLabel('First name').fill('Priya');
  await manager.getByLabel('Last name').fill('Otaguest');
  await manager.getByLabel('Room (channel code)').selectOption('SIM-STD');
  await manager.getByLabel('Arrival').fill(BUSINESS_DATE);
  await manager.getByLabel('Departure').fill('2026-07-13');
  await manager.getByRole('button', { name: 'Send booking' }).click();

  // It was accepted and given one of OUR confirmation numbers.
  await expect(alertText(manager)).toContainText(/booked as HTL-\d+/i);

  // The delivery log records it CONFIRMED.
  await expect(
    manager.getByRole('row').filter({ hasText: 'CONFIRMED' }),
  ).toBeVisible();

  // The truth underneath: a reservation exists, sourced from the channel.
  const rows = await sql`
    SELECT source FROM reservations.reservations
    WHERE property_id = ${ALPHA} AND source = 'OTA'
  `;
  expect(rows.length, 'the OTA booking never became a reservation').toBe(1);

  // And the front desk sees the guest on today's arrivals — an OTA booking is just a
  // reservation once it is in the building's records.
  const desk = await asRole('frontdesk');
  await frontDesk(desk, 'Arrivals');
  await expect(guestRow(desk, 'Priya Otaguest')).toBeVisible({ timeout: 20_000 });
});

test('availability is pushed out to the channel', async ({ asRole }) => {
  const manager = await asRole('manager');
  await manager.goto('/channels');

  // Force a full push of every mapped room type.
  await manager.getByRole('button', { name: 'Sync now' }).click();
  await expect(alertText(manager)).toContainText(/Queued a full push/i);

  // The relay delivers on its own timer; reload until the channel has heard. Once a push
  // lands, "What SimTrip sees" shows the availability under the channel's own room code.
  await expect(async () => {
    await manager.reload();
    await expect(
      manager.getByRole('cell', { name: 'SIM-STD' }).first(),
    ).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
});
