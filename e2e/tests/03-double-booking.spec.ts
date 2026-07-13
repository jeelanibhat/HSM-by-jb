import { BUSINESS_DATE, sellableRooms } from '../support/db';
import { assignRoom, bookThroughUi, expect, frontDesk, guestRow, test } from '../support/fixtures';

/**
 * TDD §8.3, case 3 — "Attempt double-book same room/date → expect rejection UI".
 *
 * The `no_double_booking` exclusion constraint lives in Postgres. This proves its
 * refusal reaches the clerk's screen as a sentence they can act on — naming the room
 * that is in the way — rather than as a 500.
 */
test('the same room cannot be given to two overlapping stays, and the UI says why', async ({
  asRole,
  sql,
}) => {
  const page = await asRole('frontdesk');
  const [room] = await sellableRooms(sql, 'STD', 1);

  // Two guests, both arriving today, with OVERLAPPING stays.
  await bookThroughUi(page, {
    firstName: 'First',
    lastName: 'Guest',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-14',
  });

  await bookThroughUi(page, {
    firstName: 'Second',
    lastName: 'Guest',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-13',
  });

  await frontDesk(page, 'Arrivals');

  // The first guest takes the room.
  await assignRoom(page, 'First Guest', room!.number);
  await expect(guestRow(page, 'First Guest').getByText(room!.number)).toBeVisible();

  // The second guest tries the SAME room. The picker still offers it — the exclusion
  // constraint needs the dates to decide, and a room that silently vanished from the
  // list would tell the clerk nothing.
  await assignRoom(page, 'Second Guest', room!.number);

  // The database's refusal, verbatim, naming the room.
  await expect(
    page.getByText(new RegExp(`Room ${room!.number} is already booked for overlapping dates`, 'i')),
  ).toBeVisible({ timeout: 15_000 });

  // And the room really is held by exactly one stay.
  const [held] = await sql`
    SELECT count(*)::int AS n
    FROM reservations.reservation_rooms
    WHERE room_id = ${room!.id} AND status NOT IN ('CANCELLED', 'NO_SHOW')
  `;

  expect(Number(held!['n']), 'the same room was held by two overlapping stays').toBe(1);
});

/**
 * SAME-DAY TURNOVER must still work. Guest A departs on the 14th, guest B arrives on
 * the 14th, same room. It is the most common thing a hotel does, and a closed date
 * range would reject it — idling the room for a night, every single time.
 */
test('ALLOWS same-day turnover: one guest departs, the next arrives, same room', async ({
  asRole,
  sql,
}) => {
  const page = await asRole('frontdesk');
  const [room] = await sellableRooms(sql, 'STD', 1);

  await bookThroughUi(page, {
    firstName: 'Departing',
    lastName: 'Guest',
    typeCode: 'STD',
    arrival: BUSINESS_DATE,
    departure: '2026-07-14',
  });

  await frontDesk(page, 'Arrivals');
  await assignRoom(page, 'Departing Guest', room!.number);
  await expect(guestRow(page, 'Departing Guest').getByText(room!.number)).toBeVisible();

  // Arrives the very day the other leaves.
  await bookThroughUi(page, {
    firstName: 'Arriving',
    lastName: 'Guest',
    typeCode: 'STD',
    arrival: '2026-07-14',
    departure: '2026-07-17',
  });

  // Their arrival is the 14th, so they are not on today's board. The tape chart is
  // where a clerk assigns a future stay — and it must offer the same room.
  await page.goto('/tape-chart');
  await expect(page.getByText('Arriving Guest')).toBeVisible({ timeout: 20_000 });

  const [line] = await sql`
    SELECT rr.id::text AS id FROM reservations.reservation_rooms rr
    JOIN reservations.reservations r ON r.id = rr.reservation_id
    JOIN guests.guests g ON g.id = r.guest_id
    WHERE g.first_name = 'Arriving'
  `;

  // The database is the thing under test here: back-to-back stays in one room.
  await sql`
    UPDATE reservations.reservation_rooms SET room_id = ${room!.id} WHERE id = ${line!['id']}
  `;

  const [held] = await sql`
    SELECT count(*)::int AS n FROM reservations.reservation_rooms
    WHERE room_id = ${room!.id} AND status NOT IN ('CANCELLED', 'NO_SHOW')
  `;

  // BOTH stays hold the room and Postgres is content. That is the half-open
  // [arrival, departure) interval doing its job.
  expect(
    Number(held!['n']),
    'same-day turnover was rejected — the room would sit empty for a night',
  ).toBe(2);
});
