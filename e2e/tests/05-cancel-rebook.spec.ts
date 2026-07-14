import { ALPHA, BUSINESS_DATE } from '../support/db';
import { bookThroughUi, expect, roomsFree, roomTypeRadio, test } from '../support/fixtures';

/**
 * TDD §8.3, case 5 — "Cancel + rebook released inventory".
 *
 * The failure this guards against is invisible until someone walks the floor: a
 * cancellation that does not give its rooms back makes the hotel slowly "sell out"
 * while sitting half empty.
 */
test('cancelling releases inventory, and the room can be sold again', async ({
  asRole,
  sql,
}) => {
  const page = await asRole('frontdesk');

  // Suites are the scarcest type in the seed — take every last one.
  await page.goto('/reservations/new');
  await page.getByLabel('Arrival').fill(BUSINESS_DATE);
  await page.getByLabel('Departure').fill('2026-07-13');
  /**
   * Wait for it to be ENABLED, not merely visible.
   *
   * Until the availability query resolves, `free` is 0 and the type renders as "sold
   * out" — so reading the count on a visible-but-unloaded radio reports zero suites in
   * a hotel that has three. Enabled means the number arrived AND it is not zero.
   */
  await expect(roomTypeRadio(page, 'SUITE')).toBeEnabled({ timeout: 25_000 });

  const total = await roomsFree(page, 'SUITE');
  expect(total).toBeGreaterThan(0);

  // Fill the hotel's suites.
  const confirmations: string[] = [];
  for (let i = 0; i < total; i++) {
    confirmations.push(
      await bookThroughUi(page, {
        firstName: 'Suite',
        lastName: `Guest${i}`,
        typeCode: 'SUITE',
        arrival: BUSINESS_DATE,
        departure: '2026-07-13',
      }),
    );
  }

  // The booking form must now refuse to offer suites at all.
  await page.goto('/reservations/new');
  await page.getByLabel('Arrival').fill(BUSINESS_DATE);
  await page.getByLabel('Departure').fill('2026-07-13');

  // Sold out, and not selectable. Nobody can promise a guest a room that is gone.
  await expect(roomTypeRadio(page, 'SUITE')).toBeDisabled({ timeout: 20_000 });
  expect(await roomsFree(page, 'SUITE')).toBe(0);

  const [full] = await sql`
    SELECT a.total, a.sold FROM reservations.room_type_availability a
    JOIN inventory.room_types t ON t.id = a.room_type_id
    WHERE a.property_id = ${ALPHA} AND t.code = 'SUITE' AND a.date = ${BUSINESS_DATE}
  `;
  expect(Number(full!['sold'])).toBe(Number(full!['total']));

  // ── Cancel one ────────────────────────────────────────────────────────────
  const [reservation] = await sql`
    SELECT id::text FROM reservations.reservations WHERE confirmation_no = ${confirmations[0]!}
  `;

  // Cancellation is not on a screen yet (it lives on the API). Drive it there, then
  // prove the UI reflects the released inventory — which is the point of the test.
  await sql`
    SELECT 1 FROM reservations.reservations WHERE id = ${reservation!['id']}
  `;

  const token = await apiToken();
  const cancelled = await apiCall(
    token,
    `mutation($i: CancelReservationGqlInput!) { cancelReservation(input: $i) { status } }`,
    { i: { reservationId: reservation!['id'], reason: 'Guest changed plans' } },
  );
  expect(cancelled.data.cancelReservation.status).toBe('CANCELLED');

  // ── The inventory came back ───────────────────────────────────────────────
  const [released] = await sql`
    SELECT a.sold FROM reservations.room_type_availability a
    JOIN inventory.room_types t ON t.id = a.room_type_id
    WHERE a.property_id = ${ALPHA} AND t.code = 'SUITE' AND a.date = ${BUSINESS_DATE}
  `;

  expect(
    Number(released!['sold']),
    'cancelling did not release the room — the hotel will slowly sell out while half empty',
  ).toBe(Number(full!['sold']) - 1);

  // ── And the booking form will sell it again ───────────────────────────────
  await page.goto('/reservations/new');
  await page.getByLabel('Arrival').fill(BUSINESS_DATE);
  await page.getByLabel('Departure').fill('2026-07-13');

  await expect(roomTypeRadio(page, 'SUITE')).toBeEnabled({ timeout: 20_000 });
  expect(await roomsFree(page, 'SUITE')).toBe(1);

  const rebooked = await bookThroughUi(page, {
    firstName: 'Rebooked',
    lastName: 'Guest',
    typeCode: 'SUITE',
    arrival: BUSINESS_DATE,
    departure: '2026-07-13',
  });

  expect(rebooked).toMatch(/^HTL-\d+$/);
});

// ── Small API helpers. Cancellation has no screen yet; the rest is UI-driven. ──

const API = process.env['E2E_API_URL'] ?? 'http://localhost:4000';

async function apiToken(): Promise<string> {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation { login(input: { email: "frontdesk@hotelos.dev", password: "Password123!" }) { accessToken } }`,
    }),
  });
  const body = await res.json();
  return body.data.login.accessToken;
}

async function apiCall(token: string, query: string, variables: unknown) {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${token}`,
      'X-Property-Id': ALPHA,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}
