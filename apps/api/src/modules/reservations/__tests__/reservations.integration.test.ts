/**
 * Reservations core — the exhaustive suite TDD §8.2 asks for:
 *
 *   "Availability engine: overlapping ranges, same-day turnover (checkout+checkin
 *    same room same date), modification shrinking/growing stays, cancellation
 *    restoring counters"
 *
 * Every guarantee here is enforced by Postgres — the exclusion constraint, the
 * row locks, the CHECK. A mocked repository would assert nothing at all.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type postgres from 'postgres';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module';
import { ownerClient } from '../../../test/db';

const ALPHA = '11111111-1111-1111-1111-111111111111';
const PASSWORD = 'Password123!';

let app: INestApplication;
let owner: postgres.Sql;
let fd = '';
let hk = '';

let stdTypeId = '';
let suiteTypeId = '';
let planId = '';

function gql(query: string, variables?: unknown, token = fd, propertyId = ALPHA) {
  return request(app.getHttpServer())
    .post('/graphql')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Property-Id', propertyId)
    .send({ query, variables });
}

const CREATE = `
  mutation($i: CreateReservationGqlInput!) {
    createReservation(input: $i) {
      id confirmationNo status arrivalDate departureDate
      rooms { id roomTypeId roomId status }
    }
  }
`;
const CANCEL = `mutation($i: CancelReservationGqlInput!) { cancelReservation(input: $i) { id status } }`;
const MODIFY = `mutation($i: ModifyReservationGqlInput!) { modifyReservation(input: $i) { id arrivalDate departureDate } }`;
const ASSIGN = `mutation($i: AssignRoomGqlInput!) { assignRoom(input: $i) { id roomId } }`;
const AVAIL = `query($f: String!, $t: String!, $rt: ID) { availability(from: $f, to: $t, roomTypeId: $rt) { date total sold blocked available } }`;

async function login(email: string) {
  const res = await request(app.getHttpServer())
    .post('/graphql')
    .send({
      query: `mutation($i: LoginInput!) { login(input: $i) { accessToken } }`,
      variables: { i: { email, password: PASSWORD } },
    });
  return res.body.data.login.accessToken as string;
}

/** Book `n` rooms of a type for a stay. Returns the GraphQL response body. */
async function book(
  roomTypeId: string,
  arrival: string,
  departure: string,
  count = 1,
  last = 'Guest',
) {
  return gql(CREATE, {
    i: {
      guest: { firstName: 'Test', lastName: last },
      source: 'DIRECT',
      arrivalDate: arrival,
      departureDate: departure,
      rooms: Array.from({ length: count }, () => ({
        roomTypeId,
        ratePlanId: planId,
        adults: 1,
        children: 0,
      })),
    },
  });
}

async function availableOn(roomTypeId: string, date: string): Promise<number> {
  const res = await gql(AVAIL, { f: date, t: date, rt: roomTypeId });
  return res.body.data.availability[0].available;
}

/** Remove everything this suite created; leave the seed untouched. */
async function wipeReservations() {
  await owner`DELETE FROM reservations.reservation_rooms WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.reservations WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.room_type_availability WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM guests.guests WHERE property_id = ${ALPHA}`;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  owner = ownerClient();
  fd = await login('frontdesk@hotelos.dev');
  hk = await login('housekeeping@hotelos.dev');

  const [std] = await owner`SELECT id FROM inventory.room_types WHERE property_id=${ALPHA} AND code='STD'`;
  const [suite] = await owner`SELECT id FROM inventory.room_types WHERE property_id=${ALPHA} AND code='SUITE'`;
  const [plan] = await owner`SELECT id FROM inventory.rate_plans WHERE property_id=${ALPHA} AND code='BAR'`;

  stdTypeId = std!['id'] as string;
  suiteTypeId = suite!['id'] as string;
  planId = plan!['id'] as string;

  await wipeReservations();
}, 90_000);

afterAll(async () => {
  await wipeReservations();
  await owner?.end();
  await app?.close();
});

afterEach(async () => {
  await wipeReservations();
});

describe('creating a reservation', () => {
  it('books a stay and issues a confirmation number', async () => {
    const res = await book(stdTypeId, '2026-09-01', '2026-09-04');
    const r = res.body.data.createReservation;

    expect(r.confirmationNo).toMatch(/^HTL-\d+$/);
    expect(r.status).toBe('CONFIRMED');
    expect(r.rooms).toHaveLength(1);

    // Sold a room TYPE, not a room. The physical room is picked later.
    expect(r.rooms[0].roomId).toBeNull();
  });

  it('consumes availability for every night of the stay, and no others', async () => {
    const before = await availableOn(stdTypeId, '2026-09-01');

    await book(stdTypeId, '2026-09-01', '2026-09-04'); // nights: 1, 2, 3

    expect(await availableOn(stdTypeId, '2026-09-01')).toBe(before - 1);
    expect(await availableOn(stdTypeId, '2026-09-02')).toBe(before - 1);
    expect(await availableOn(stdTypeId, '2026-09-03')).toBe(before - 1);

    // THE DEPARTURE NIGHT IS NOT PART OF THE STAY. Charging or holding it would
    // silently cost the hotel a sellable night on every single booking.
    expect(await availableOn(stdTypeId, '2026-09-04')).toBe(before);
  });

  it('rejects a zero-night stay', async () => {
    const res = await book(stdTypeId, '2026-09-01', '2026-09-01');
    expect(res.body.errors).toBeTruthy();
  });

  it('rejects a departure before arrival', async () => {
    const res = await book(stdTypeId, '2026-09-05', '2026-09-01');
    expect(res.body.errors).toBeTruthy();
  });

  it('books several rooms on one reservation', async () => {
    const before = await availableOn(stdTypeId, '2026-09-01');

    const res = await book(stdTypeId, '2026-09-01', '2026-09-03', 3);
    expect(res.body.data.createReservation.rooms).toHaveLength(3);

    expect(await availableOn(stdTypeId, '2026-09-01')).toBe(before - 3);
  });
});

/**
 * The counters must not drift. A hotel that "sells out" while half empty is the
 * failure mode here, and it is invisible until someone walks the floor.
 */
describe('availability engine', () => {
  it('refuses to sell more rooms than exist', async () => {
    // 2 suites in the seed. Take both.
    const total = (await gql(AVAIL, { f: '2026-09-10', t: '2026-09-10', rt: suiteTypeId })).body.data
      .availability[0].total;

    await book(suiteTypeId, '2026-09-10', '2026-09-11', total);
    expect(await availableOn(suiteTypeId, '2026-09-10')).toBe(0);

    const oneTooMany = await book(suiteTypeId, '2026-09-10', '2026-09-11', 1, 'Unlucky');
    expect(oneTooMany.body.errors).toBeTruthy();
    expect(oneTooMany.body.errors[0].message).toMatch(/no availability/i);
  });

  it('names the night that is full, not just "unavailable"', async () => {
    const total = (await gql(AVAIL, { f: '2026-09-20', t: '2026-09-20', rt: suiteTypeId })).body.data
      .availability[0].total;

    await book(suiteTypeId, '2026-09-20', '2026-09-21', total);

    // A stay spanning the full night should fail, naming it.
    const res = await book(suiteTypeId, '2026-09-19', '2026-09-22', 1, 'Spanner');
    expect(res.body.errors[0].message).toContain('2026-09-20');
  });

  it('a night that is full does not block an adjacent night', async () => {
    const total = (await gql(AVAIL, { f: '2026-09-25', t: '2026-09-25', rt: suiteTypeId })).body.data
      .availability[0].total;

    await book(suiteTypeId, '2026-09-25', '2026-09-26', total);

    expect(await availableOn(suiteTypeId, '2026-09-25')).toBe(0);
    expect(await availableOn(suiteTypeId, '2026-09-26')).toBe(total);

    const next = await book(suiteTypeId, '2026-09-26', '2026-09-27', 1, 'NextNight');
    expect(next.body.errors).toBeFalsy();
  });

  it('counts OOO rooms as blocked, not sellable', async () => {
    const grid = (await gql(AVAIL, { f: '2026-09-01', t: '2026-09-01', rt: stdTypeId })).body.data
      .availability[0];

    // The seed puts some STD rooms OOO.
    expect(grid.blocked).toBeGreaterThan(0);
    expect(grid.available).toBe(grid.total - grid.sold - grid.blocked);
  });

  it('reports full availability for a night nobody has touched (no counter row)', async () => {
    const rows = await owner`
      SELECT 1 FROM reservations.room_type_availability
      WHERE property_id = ${ALPHA} AND date = '2027-06-15'
    `;
    expect(rows).toHaveLength(0); // no row exists

    const grid = (await gql(AVAIL, { f: '2027-06-15', t: '2027-06-15', rt: stdTypeId })).body.data
      .availability[0];

    // A missing row means "nobody has booked", not "nothing available". Getting
    // this backwards would make the hotel look sold out a year ahead.
    expect(grid.sold).toBe(0);
    expect(grid.available).toBe(grid.total - grid.blocked);
  });
});

/**
 * THE race. Two clerks, one room left, same instant.
 */
describe('concurrency', () => {
  it('lets exactly ONE of two simultaneous bookings take the last room', async () => {
    const total = (await gql(AVAIL, { f: '2026-10-01', t: '2026-10-01', rt: suiteTypeId })).body.data
      .availability[0].total;

    // Fill everything but one.
    if (total > 1) await book(suiteTypeId, '2026-10-01', '2026-10-02', total - 1);
    expect(await availableOn(suiteTypeId, '2026-10-01')).toBe(1);

    // Two bookings fired at the same moment for that last room.
    const [a, b] = await Promise.all([
      book(suiteTypeId, '2026-10-01', '2026-10-02', 1, 'RacerA'),
      book(suiteTypeId, '2026-10-01', '2026-10-02', 1, 'RacerB'),
    ]);

    const winners = [a, b].filter((r) => !r.body.errors);
    const losers = [a, b].filter((r) => r.body.errors);

    expect(winners, 'both bookings succeeded — the room was oversold').toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]!.body.errors[0].message).toMatch(/no availability/i);

    expect(await availableOn(suiteTypeId, '2026-10-01')).toBe(0);
  });
});

describe('cancellation restores the counters (TDD §8.2)', () => {
  it('gives the inventory back', async () => {
    const before = await availableOn(stdTypeId, '2026-11-01');

    const res = await book(stdTypeId, '2026-11-01', '2026-11-04', 2);
    const id = res.body.data.createReservation.id;

    expect(await availableOn(stdTypeId, '2026-11-01')).toBe(before - 2);

    const cancelled = await gql(CANCEL, {
      i: { reservationId: id, reason: 'Guest changed plans' },
    });
    expect(cancelled.body.data.cancelReservation.status).toBe('CANCELLED');

    // If this leaked, the hotel would slowly "sell out" while sitting empty.
    expect(await availableOn(stdTypeId, '2026-11-01')).toBe(before);
    expect(await availableOn(stdTypeId, '2026-11-03')).toBe(before);
  });

  it('releases the room so it can be rebooked (E2E case 5)', async () => {
    const total = (await gql(AVAIL, { f: '2026-11-10', t: '2026-11-10', rt: suiteTypeId })).body.data
      .availability[0].total;

    const first = await book(suiteTypeId, '2026-11-10', '2026-11-12', total);
    expect(await availableOn(suiteTypeId, '2026-11-10')).toBe(0);

    await gql(CANCEL, {
      i: { reservationId: first.body.data.createReservation.id, reason: 'No longer needed' },
    });

    const rebook = await book(suiteTypeId, '2026-11-10', '2026-11-12', total, 'Rebooker');
    expect(rebook.body.errors, 'cancelled inventory was not released').toBeFalsy();
  });

  it('does not double-release when cancelled twice', async () => {
    const before = await availableOn(stdTypeId, '2026-11-20');

    const res = await book(stdTypeId, '2026-11-20', '2026-11-22');
    const id = res.body.data.createReservation.id;

    await gql(CANCEL, { i: { reservationId: id, reason: 'First cancel' } });

    // CANCELLED is terminal — the state machine must refuse a second cancel.
    // Without that, `sold` would go negative and the hotel would think it has
    // more rooms than it owns.
    const again = await gql(CANCEL, { i: { reservationId: id, reason: 'Second cancel' } });
    expect(again.body.errors).toBeTruthy();

    expect(await availableOn(stdTypeId, '2026-11-20')).toBe(before);
  });

  it('requires a reason — it feeds the audit log', async () => {
    const res = await book(stdTypeId, '2026-11-25', '2026-11-26');
    const bad = await gql(CANCEL, {
      i: { reservationId: res.body.data.createReservation.id, reason: '' },
    });
    expect(bad.body.errors).toBeTruthy();
  });
});

describe('modifying a stay (TDD §8.2: shrinking / growing)', () => {
  it('growing a stay takes the extra nights', async () => {
    const before3 = await availableOn(stdTypeId, '2026-12-03');

    const res = await book(stdTypeId, '2026-12-01', '2026-12-03'); // nights 1,2
    const id = res.body.data.createReservation.id;

    expect(await availableOn(stdTypeId, '2026-12-03')).toBe(before3); // not held yet

    await gql(MODIFY, {
      i: { reservationId: id, arrivalDate: '2026-12-01', departureDate: '2026-12-05' },
    });

    // Now nights 1..4 are held; the 3rd is consumed, the 5th (departure) is not.
    expect(await availableOn(stdTypeId, '2026-12-03')).toBe(before3 - 1);
    expect(await availableOn(stdTypeId, '2026-12-05')).toBe(
      await availableOn(stdTypeId, '2026-12-06'),
    );
  });

  it('shrinking a stay gives the dropped nights back', async () => {
    const before = await availableOn(stdTypeId, '2026-12-13');

    const res = await book(stdTypeId, '2026-12-10', '2026-12-15');
    const id = res.body.data.createReservation.id;

    expect(await availableOn(stdTypeId, '2026-12-13')).toBe(before - 1);

    await gql(MODIFY, {
      i: { reservationId: id, arrivalDate: '2026-12-10', departureDate: '2026-12-12' },
    });

    // The 13th is released; the 11th is still held.
    expect(await availableOn(stdTypeId, '2026-12-13')).toBe(before);
    expect(await availableOn(stdTypeId, '2026-12-11')).toBe(before - 1);
  });

  it('moving a stay entirely releases the old nights and takes the new', async () => {
    const beforeOld = await availableOn(stdTypeId, '2026-12-20');
    const beforeNew = await availableOn(stdTypeId, '2026-12-27');

    const res = await book(stdTypeId, '2026-12-20', '2026-12-22');
    const id = res.body.data.createReservation.id;

    await gql(MODIFY, {
      i: { reservationId: id, arrivalDate: '2026-12-27', departureDate: '2026-12-29' },
    });

    expect(await availableOn(stdTypeId, '2026-12-20')).toBe(beforeOld);
    expect(await availableOn(stdTypeId, '2026-12-27')).toBe(beforeNew - 1);
  });

  /**
   * The rollback case. A failed extension must not cost the guest the booking
   * they already had.
   */
  it('leaves the ORIGINAL booking intact when the new dates are unavailable', async () => {
    const total = (await gql(AVAIL, { f: '2027-01-16', t: '2027-01-16', rt: suiteTypeId })).body.data
      .availability[0].total;

    // Take one suite for the 15th.
    const mine = await book(suiteTypeId, '2027-01-15', '2027-01-16');
    const id = mine.body.data.createReservation.id;

    // Someone else fills the 16th completely.
    await book(suiteTypeId, '2027-01-16', '2027-01-17', total, 'Blocker');

    // Try to extend into the full night.
    const res = await gql(MODIFY, {
      i: { reservationId: id, arrivalDate: '2027-01-15', departureDate: '2027-01-17' },
    });
    expect(res.body.errors).toBeTruthy();

    // The original stay must survive. Release-then-hold in one transaction means
    // the release rolls back with the failed hold.
    const check = await gql(
      `query($id: ID!) { reservation(id: $id) { arrivalDate departureDate status } }`,
      { id },
    );
    expect(check.body.data.reservation).toMatchObject({
      arrivalDate: '2027-01-15',
      departureDate: '2027-01-16',
      status: 'CONFIRMED',
    });

    // ...and its night is still held.
    expect(await availableOn(suiteTypeId, '2027-01-15')).toBe(total - 1);
  });

  it('refuses to modify a cancelled reservation', async () => {
    const res = await book(stdTypeId, '2027-02-01', '2027-02-03');
    const id = res.body.data.createReservation.id;

    await gql(CANCEL, { i: { reservationId: id, reason: 'Gone' } });

    const mod = await gql(MODIFY, {
      i: { reservationId: id, arrivalDate: '2027-02-01', departureDate: '2027-02-05' },
    });
    expect(mod.body.errors[0].message).toMatch(/cannot be modified/i);
  });
});

/**
 * The exclusion constraint — the last line of defence (TDD §4.3).
 */
describe('room assignment and the double-booking constraint', () => {
  async function roomOfType(typeId: string, offset = 0) {
    const rows = await owner`
      SELECT id, number FROM inventory.rooms
      WHERE property_id = ${ALPHA} AND room_type_id = ${typeId} AND status NOT IN ('OOO','OOS')
      ORDER BY number
    `;
    return rows[offset] as { id: string; number: string };
  }

  it('assigns a physical room to a booking', async () => {
    const res = await book(stdTypeId, '2027-03-01', '2027-03-04');
    const line = res.body.data.createReservation.rooms[0];
    const room = await roomOfType(stdTypeId);

    const assigned = await gql(ASSIGN, {
      i: { reservationRoomId: line.id, roomId: room.id },
    });
    expect(assigned.body.data.assignRoom.roomId).toBe(room.id);
  });

  it('REFUSES to put the same room in two overlapping stays', async () => {
    const room = await roomOfType(stdTypeId);

    const a = await book(stdTypeId, '2027-03-10', '2027-03-14', 1, 'First');
    await gql(ASSIGN, {
      i: { reservationRoomId: a.body.data.createReservation.rooms[0].id, roomId: room.id },
    });

    const b = await book(stdTypeId, '2027-03-12', '2027-03-16', 1, 'Overlapper');
    const clash = await gql(ASSIGN, {
      i: { reservationRoomId: b.body.data.createReservation.rooms[0].id, roomId: room.id },
    });

    expect(clash.body.errors, 'the same room was double-booked').toBeTruthy();
    expect(clash.body.errors[0].message).toMatch(/already booked/i);
    // Not a 500 — an expected domain outcome the front desk can act on.
    expect(clash.body.errors[0].message).toContain(room.number);
  });

  /**
   * SAME-DAY TURNOVER. Guest A leaves on the 14th, guest B arrives on the 14th,
   * same room. This is the most common thing a hotel does, and a closed date range
   * would reject it — idling the room for a night, every time.
   */
  it('ALLOWS same-day turnover: checkout and check-in on the same date, same room', async () => {
    const room = await roomOfType(stdTypeId);

    const a = await book(stdTypeId, '2027-04-01', '2027-04-05', 1, 'Departing');
    await gql(ASSIGN, {
      i: { reservationRoomId: a.body.data.createReservation.rooms[0].id, roomId: room.id },
    });

    // Arrives the very day the other departs.
    const b = await book(stdTypeId, '2027-04-05', '2027-04-08', 1, 'Arriving');
    const turnover = await gql(ASSIGN, {
      i: { reservationRoomId: b.body.data.createReservation.rooms[0].id, roomId: room.id },
    });

    expect(
      turnover.body.errors,
      'same-day turnover was rejected — the room would sit empty for a night',
    ).toBeFalsy();
    expect(turnover.body.data.assignRoom.roomId).toBe(room.id);
  });

  it('frees the room for reassignment once the clashing stay is cancelled', async () => {
    const room = await roomOfType(stdTypeId);

    const a = await book(stdTypeId, '2027-05-01', '2027-05-05', 1, 'Holder');
    await gql(ASSIGN, {
      i: { reservationRoomId: a.body.data.createReservation.rooms[0].id, roomId: room.id },
    });

    const b = await book(stdTypeId, '2027-05-02', '2027-05-06', 1, 'Waiting');
    const blocked = await gql(ASSIGN, {
      i: { reservationRoomId: b.body.data.createReservation.rooms[0].id, roomId: room.id },
    });
    expect(blocked.body.errors).toBeTruthy();

    await gql(CANCEL, {
      i: { reservationId: a.body.data.createReservation.id, reason: 'Cancelled' },
    });

    // A cancelled stay releases its room — that is the constraint's WHERE clause.
    const now = await gql(ASSIGN, {
      i: { reservationRoomId: b.body.data.createReservation.rooms[0].id, roomId: room.id },
    });
    expect(now.body.errors).toBeFalsy();
  });

  it('refuses a room of the wrong type', async () => {
    const res = await book(suiteTypeId, '2027-06-01', '2027-06-03');
    const stdRoom = await roomOfType(stdTypeId);

    const wrong = await gql(ASSIGN, {
      i: { reservationRoomId: res.body.data.createReservation.rooms[0].id, roomId: stdRoom.id },
    });

    // Selling a Suite and handing over a Standard is a complaint at check-out.
    expect(wrong.body.errors[0].message).toMatch(/not of the booked room type/i);
  });

  it('refuses an out-of-order room', async () => {
    const [ooo] = await owner`
      SELECT id, room_type_id FROM inventory.rooms
      WHERE property_id = ${ALPHA} AND status = 'OOO' LIMIT 1
    `;

    const res = await book(ooo!['room_type_id'] as string, '2027-07-01', '2027-07-03');
    const bad = await gql(ASSIGN, {
      i: { reservationRoomId: res.body.data.createReservation.rooms[0].id, roomId: ooo!['id'] },
    });

    expect(bad.body.errors[0].message).toMatch(/out of order/i);
  });

  it('refuses to assign a room to a cancelled booking', async () => {
    const res = await book(stdTypeId, '2027-08-01', '2027-08-03');
    const line = res.body.data.createReservation.rooms[0];
    const room = await roomOfType(stdTypeId);

    await gql(CANCEL, {
      i: { reservationId: res.body.data.createReservation.id, reason: 'Gone' },
    });

    const bad = await gql(ASSIGN, { i: { reservationRoomId: line.id, roomId: room.id } });
    expect(bad.body.errors[0].message).toMatch(/cannot assign a room to a cancelled/i);
  });
});

describe('audit and events', () => {
  it('audits and emits on create and cancel', async () => {
    const res = await book(stdTypeId, '2027-09-01', '2027-09-03');
    const id = res.body.data.createReservation.id;

    await gql(CANCEL, { i: { reservationId: id, reason: 'Testing the trail' } });

    const audits = await owner`
      SELECT action, reason FROM shared.audit_log
      WHERE entity_id = ${id} ORDER BY at
    `;
    expect(audits.map((a) => a['action'])).toEqual([
      'reservation.created',
      'reservation.cancelled',
    ]);
    expect(audits[1]?.['reason']).toBe('Testing the trail');

    const events = await owner`
      SELECT event_type FROM shared.outbox_events
      WHERE aggregate_id = ${id} ORDER BY created_at
    `;
    expect(events.map((e) => e['event_type'])).toEqual([
      'reservation.created',
      'reservation.cancelled',
    ]);
  });

  it('leaves no phantom event when the booking fails on availability', async () => {
    const total = (await gql(AVAIL, { f: '2027-10-01', t: '2027-10-01', rt: suiteTypeId })).body.data
      .availability[0].total;

    await book(suiteTypeId, '2027-10-01', '2027-10-02', total);

    const before = await owner`SELECT count(*)::int n FROM shared.outbox_events`;
    const failed = await book(suiteTypeId, '2027-10-01', '2027-10-02', 1, 'Doomed');
    expect(failed.body.errors).toBeTruthy();

    const after = await owner`SELECT count(*)::int n FROM shared.outbox_events`;
    expect(after[0]?.['n'], 'a reservation.created event fired for a booking that failed').toBe(
      before[0]?.['n'],
    );
  });
});

describe('RBAC', () => {
  it('refuses housekeeping taking a booking', async () => {
    const res = await gql(
      CREATE,
      {
        i: {
          guest: { firstName: 'A', lastName: 'B' },
          source: 'DIRECT',
          arrivalDate: '2027-11-01',
          departureDate: '2027-11-03',
          rooms: [{ roomTypeId: stdTypeId, ratePlanId: planId, adults: 1, children: 0 }],
        },
      },
      hk,
    );
    expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
  });
});
