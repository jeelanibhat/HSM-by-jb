import postgres from 'postgres';

const OWNER_URL =
  process.env['DATABASE_MIGRATION_URL'] ?? 'postgresql://hotelos:hotelos@localhost:5432/hotelos';

export const ALPHA = '11111111-1111-1111-1111-111111111111';
export const BETA = '22222222-2222-2222-2222-222222222222';
export const PASSWORD = 'Password123!';

/** The trading day every spec starts from. Fixed, so the suite is reproducible. */
export const BUSINESS_DATE = '2026-07-11';

/**
 * Owner connection. Test setup only — never the subject of an assertion.
 *
 * The DATE override matters: without it a Postgres DATE comes back as a JS Date in
 * the runner's local timezone, which is the exact bug §6 exists to prevent. A test
 * would then be asserting on a value the application never sees.
 */
export function db(): postgres.Sql {
  return postgres(OWNER_URL, {
    max: 2,
    onnotice: () => {},
    types: {
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
    } as never,
  });
}

/**
 * Return the hotel to a known morning.
 *
 * Deletes every transactional row (bookings, folios, guests, audit runs, frozen
 * stats), resets all rooms to clean, and puts the business date back. The SEED —
 * users, rooms, room types, rate plans, prices — is left alone: it is fixture, not
 * state, and re-seeding it on every run would make the suite slow for no gain.
 */
export async function resetHotel(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    DELETE FROM pos.order_lines;
    DELETE FROM pos.orders;
    DELETE FROM housekeeping.tasks;
    DELETE FROM reporting.daily_stats;
    DELETE FROM shared.night_audit_runs;
    DELETE FROM folio.invoices;
    DELETE FROM folio.folio_lines;
    DELETE FROM folio.folios;
    DELETE FROM reservations.reservation_rooms;
    DELETE FROM reservations.reservations;
    DELETE FROM reservations.room_type_availability;
    DELETE FROM guests.guests;
    DELETE FROM shared.outbox_events;

    UPDATE inventory.rooms SET status = 'VACANT_CLEAN'
      WHERE status IN ('OCCUPIED', 'VACANT_DIRTY');

    UPDATE property.properties SET business_date = '${BUSINESS_DATE}';
  `);
}

/** Room numbers we can rely on being sellable — used to assert on a known room. */
export async function sellableRooms(sql: postgres.Sql, typeCode: string, limit = 3) {
  return sql<Array<{ id: string; number: string }>>`
    SELECT r.id::text, r.number
    FROM inventory.rooms r
    JOIN inventory.room_types t ON t.id = r.room_type_id
    WHERE r.property_id = ${ALPHA}
      AND t.code = ${typeCode}
      AND r.status = 'VACANT_CLEAN'
    ORDER BY r.number
    LIMIT ${limit}
  `;
}
