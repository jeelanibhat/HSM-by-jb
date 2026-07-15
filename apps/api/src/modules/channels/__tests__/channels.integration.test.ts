/**
 * Channel manager (Phase 2): availability out, bookings in.
 *
 * The module makes one promise in each direction, and this file is about keeping them:
 *
 *   OUT — when a room sells, the channels are told. A push carries the CURRENT
 *         availability, in the channel's own room codes.
 *   IN  — a booking the channel delivered becomes a real reservation, exactly once, and
 *         is refused rather than oversold when the room is gone.
 *
 * Runs against the real API — real guards, real RLS, real transactions, the real outbox
 * feeding the outbound worker. Both relays are drained by hand (see the config) so a push
 * is asserted, never raced.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module';
import { ownerClient } from '../../../test/db';
import { OutboxRelay } from '../../../shared';
import { ChannelSyncRelay, SimulatedOtaConnector } from '..';

const ALPHA = '11111111-1111-1111-1111-111111111111';
const BETA = '22222222-2222-2222-2222-222222222222';
const PASSWORD = 'Password123!';
const D0 = '2026-07-11';

let app: INestApplication;
let owner: postgres.Sql;
let outbox: OutboxRelay;
let sync: ChannelSyncRelay;
let connector: SimulatedOtaConnector;

const tokens: Record<string, string> = {};
let channelId = '';
let stdTypeId = '';
let dlxTypeId = '';
let planId = '';

function gql(query: string, variables?: unknown, opts: { token?: string; propertyId?: string } = {}) {
  const req = request(app.getHttpServer()).post('/graphql');
  if (opts.token) req.set('Authorization', `Bearer ${opts.token}`);
  if (opts.propertyId) req.set('X-Property-Id', opts.propertyId);
  return req.send({ query, variables });
}

function as(who: string, query: string, variables?: unknown, propertyId = ALPHA) {
  return gql(query, variables, { token: tokens[who]!, propertyId });
}

async function login(email: string): Promise<string> {
  const res = await gql(`mutation($i: LoginInput!) { login(input: $i) { accessToken } }`, {
    i: { email, password: PASSWORD },
  });
  return res.body.data.login.accessToken;
}

const SIMULATE = `mutation($i: SimulateChannelBookingGqlInput!) {
  simulateChannelBooking(input: $i) { outcome externalRef reservationId confirmationNo reason }
}`;
const RESYNC = `mutation($i: ResyncChannelGqlInput!) { resyncChannel(input: $i) { queued } }`;
const CHANNELS = `{ channels { id code name enabled roomTypeMappings { roomTypeId externalRoomCode } } }`;

/** Make a direct booking for a room type over [arrival, departure). Returns its id. */
async function directBooking(typeId: string, last: string, arrival: string, departure: string) {
  const res = await as(
    'frontdesk',
    `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id } }`,
    {
      i: {
        guest: { firstName: 'Direct', lastName: last },
        source: 'PHONE',
        arrivalDate: arrival,
        departureDate: departure,
        rooms: [{ roomTypeId: typeId, ratePlanId: planId, adults: 2, children: 0 }],
      },
    },
  );
  if (!res.body.data?.createReservation) {
    throw new Error(`direct booking failed: ${JSON.stringify(res.body.errors)}`);
  }
  return res.body.data.createReservation.id as string;
}

/** Push whatever is queued all the way to the channel: outbox → worker → sync relay. */
async function flush() {
  await outbox.drain();
  return sync.drainOnce();
}

/**
 * The availability our own engine reports for a room type on a date — total sellable
 * rooms minus what is sold. Seeded room counts and OOO rooms vary, so the tests assert
 * against THIS rather than hardcoded numbers: the point is that the channel hears what we
 * see, and that a booking moves it by one.
 */
async function availableFor(typeCode: string, date: string): Promise<number> {
  const [row] = await owner`
    SELECT (
      SELECT count(*) FROM inventory.rooms r
      JOIN inventory.room_types t ON t.id = r.room_type_id
      WHERE r.property_id = ${ALPHA} AND t.code = ${typeCode} AND r.status NOT IN ('OOO','OOS')
    ) - COALESCE((
      SELECT a.sold FROM reservations.room_type_availability a
      JOIN inventory.room_types t ON t.id = a.room_type_id
      WHERE a.property_id = ${ALPHA} AND t.code = ${typeCode} AND a.date = ${date}
    ), 0) AS avail
  `;
  return Number(row!['avail']);
}

/** What the channel currently believes the availability is for a code+date. */
function pushedAvailable(code: string, date: string): number | undefined {
  return connector.currentAri(channelId).find((a) => a.externalRoomCode === code && a.date === date)
    ?.available;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  owner = ownerClient();
  outbox = app.get(OutboxRelay);
  sync = app.get(ChannelSyncRelay);
  connector = app.get(SimulatedOtaConnector);

  for (const who of ['admin', 'manager', 'frontdesk', 'housekeeping', 'pos']) {
    tokens[who] = await login(`${who}@hotelos.dev`);
  }

  const [channel] = await owner`SELECT id FROM channel.channels WHERE property_id = ${ALPHA} AND code = 'SIM_OTA'`;
  channelId = channel!['id'] as string;

  const [std] = await owner`SELECT id FROM inventory.room_types WHERE property_id = ${ALPHA} AND code = 'STD'`;
  const [dlx] = await owner`SELECT id FROM inventory.room_types WHERE property_id = ${ALPHA} AND code = 'DLX'`;
  const [plan] = await owner`SELECT id FROM inventory.rate_plans WHERE property_id = ${ALPHA} LIMIT 1`;
  stdTypeId = std!['id'] as string;
  dlxTypeId = dlx!['id'] as string;
  planId = plan!['id'] as string;
}, 90_000);

afterAll(async () => {
  await owner?.end();
  await app?.close();
});

beforeEach(async () => {
  await owner`DELETE FROM channel.channel_outbound WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM channel.channel_bookings WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM folio.folio_lines WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM folio.folios WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.reservation_rooms WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.reservations WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.room_type_availability WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM guests.guests WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM shared.outbox_events`;
  await owner`UPDATE inventory.rooms SET status = 'VACANT_CLEAN'
              WHERE property_id = ${ALPHA} AND status IN ('OCCUPIED','VACANT_DIRTY')`;
  await owner`UPDATE property.properties SET business_date = ${D0} WHERE id = ${ALPHA}`;
  connector.reset();
});

// ── Outbound: availability push ────────────────────────────────────────────────

describe('pushing availability out', () => {
  it('tells the channel the CURRENT availability, in its own room codes', async () => {
    const before = await availableFor('STD', '2026-07-20');

    await directBooking(stdTypeId, 'Away', '2026-07-20', '2026-07-22');
    const pushed = await flush();

    expect(pushed).toBeGreaterThan(0);

    // The channel hears our CODE, not our id, and the count is one lower than before.
    expect(pushedAvailable('SIM-STD', '2026-07-20')).toBe(before - 1);
    expect(pushedAvailable('SIM-STD', '2026-07-21')).toBe(before - 1);

    // The departure night is NOT part of the stay, so it is not in this push's range.
    const ari = connector.currentAri(channelId).filter((a) => a.externalRoomCode === 'SIM-STD');
    expect(ari.some((a) => a.date === '2026-07-22')).toBe(false);
  });

  it('a cancellation pushes the freed room back to the channel', async () => {
    const before = await availableFor('STD', '2026-07-20');

    const id = await directBooking(stdTypeId, 'Fickle', '2026-07-20', '2026-07-21');
    await flush();
    expect(pushedAvailable('SIM-STD', '2026-07-20')).toBe(before - 1);

    await as('frontdesk', `mutation($i: CancelReservationGqlInput!) { cancelReservation(input: $i) { id } }`, {
      i: { reservationId: id, reason: 'guest called off' },
    });
    await flush();

    // Back to where we started — the snapshot reflects the cancellation, not a stale hold.
    expect(pushedAvailable('SIM-STD', '2026-07-20')).toBe(before);
  });

  it('a manual resync pushes every mapped room type, with the nightly rate', async () => {
    const res = await as('manager', RESYNC, { i: { channelId } });
    expect(res.body.data.resyncChannel.queued).toBe(3); // STD, DLX, SUITE
    await flush();

    const ari = connector.currentAri(channelId);
    expect(new Set(ari.map((a) => a.externalRoomCode))).toEqual(
      new Set(['SIM-STD', 'SIM-DLX', 'SIM-SUITE']),
    );

    // The BAR plan is mapped, so a price rides along. STD is ₹3,500 in the seed.
    const std = ari.find((a) => a.externalRoomCode === 'SIM-STD');
    expect(std!.priceMinor).toBe(350_000);
  });

  it('a failed push is retried, not lost', async () => {
    await directBooking(stdTypeId, 'Retry', '2026-07-20', '2026-07-21');
    await outbox.drain(); // enqueue the push

    connector.failNextPush(channelId); // the channel is "down" for one attempt
    expect(await sync.drainOnce()).toBe(0); // nothing landed

    const [after] = await owner`
      SELECT status, attempts FROM channel.channel_outbound WHERE channel_id = ${channelId}
    `;
    expect(after!['status']).toBe('PENDING'); // back on the queue
    expect(Number(after!['attempts'])).toBe(1);

    // Its next_attempt_at was pushed into the future by the back-off; force it due and
    // the retry succeeds.
    await owner`UPDATE channel.channel_outbound SET next_attempt_at = now() WHERE channel_id = ${channelId}`;
    expect(await sync.drainOnce()).toBe(1);
    expect(connector.currentAri(channelId).length).toBeGreaterThan(0);
  });
});

// ── Inbound: booking delivery ──────────────────────────────────────────────────

describe('taking a booking in', () => {
  const bookingInput = (over: Partial<Record<string, unknown>> = {}) => ({
    i: {
      channelId,
      externalRef: 'OTA-1001',
      externalRoomCode: 'SIM-STD',
      externalRateCode: 'SIM-BAR',
      firstName: 'Olivia',
      lastName: 'Ota',
      arrivalDate: '2026-07-20',
      departureDate: '2026-07-22',
      adults: 2,
      children: 0,
      ...over,
    },
  });

  it('becomes a real reservation, sourced OTA', async () => {
    const res = await as('manager', SIMULATE, bookingInput());
    const r = res.body.data.simulateChannelBooking;

    expect(r.outcome).toBe('CONFIRMED');
    expect(r.confirmationNo).toMatch(/^HTL-/);
    expect(r.reservationId).toBeTruthy();

    const [reservation] = await owner`
      SELECT source, status FROM reservations.reservations WHERE id = ${r.reservationId}
    `;
    expect(reservation!['source']).toBe('OTA');

    const [booking] = await owner`
      SELECT status, reservation_id FROM channel.channel_bookings WHERE external_ref = 'OTA-1001'
    `;
    expect(booking!['status']).toBe('CONFIRMED');
    expect(booking!['reservation_id']).toBe(r.reservationId);
  });

  it('closes the room it took — the next push shows one fewer', async () => {
    const before = await availableFor('STD', '2026-07-20');

    await as('manager', SIMULATE, bookingInput());
    await flush();

    expect(pushedAvailable('SIM-STD', '2026-07-20')).toBe(before - 1);
  });

  it('is idempotent — a redelivered booking is a DUPLICATE, not a second reservation', async () => {
    const first = await as('manager', SIMULATE, bookingInput());
    expect(first.body.data.simulateChannelBooking.outcome).toBe('CONFIRMED');

    const again = await as('manager', SIMULATE, bookingInput());
    expect(again.body.data.simulateChannelBooking.outcome).toBe('DUPLICATE');

    const rows = await owner`SELECT count(*)::int AS n FROM reservations.reservations WHERE property_id = ${ALPHA}`;
    expect(rows[0]!['n']).toBe(1); // still just the one
  });

  it('REJECTS a booking whose room the channel has no mapping for', async () => {
    const res = await as('manager', SIMULATE, bookingInput({ externalRef: 'OTA-BADCODE', externalRoomCode: 'SIM-NOPE' }));
    const r = res.body.data.simulateChannelBooking;

    expect(r.outcome).toBe('REJECTED');
    expect(r.reason).toMatch(/mapping/i);

    const rows = await owner`SELECT count(*)::int AS n FROM reservations.reservations WHERE property_id = ${ALPHA}`;
    expect(rows[0]!['n']).toBe(0); // nothing was booked
  });

  it('REJECTS rather than oversells when the room is gone', async () => {
    // Fill every sellable DLX room directly, then the channel's next one has nowhere to
    // go. The exact count is read from inventory rather than assumed.
    const free = await availableFor('DLX', '2026-07-20');
    expect(free).toBeGreaterThan(0);
    for (let i = 0; i < free; i++) {
      await directBooking(dlxTypeId, `Full${i}`, '2026-07-20', '2026-07-22');
    }
    expect(await availableFor('DLX', '2026-07-20')).toBe(0);

    const res = await as(
      'manager',
      SIMULATE,
      bookingInput({ externalRef: 'OTA-OVERSELL', externalRoomCode: 'SIM-DLX' }),
    );
    const r = res.body.data.simulateChannelBooking;

    expect(r.outcome).toBe('REJECTED');
    expect(r.reason).toMatch(/availab/i);

    const [booking] = await owner`
      SELECT status FROM channel.channel_bookings WHERE external_ref = 'OTA-OVERSELL'
    `;
    expect(booking!['status']).toBe('REJECTED');
  });
});

// ── RBAC & tenancy ─────────────────────────────────────────────────────────────

describe('who may work the channels', () => {
  it('refuses a front-desk clerk — this is a management screen', async () => {
    const res = await as('frontdesk', CHANNELS);
    expect(res.body.data).toBeFalsy();
    expect(JSON.stringify(res.body.errors)).toMatch(/forbidden|permission|role/i);
  });

  it('refuses a waiter', async () => {
    const res = await as('pos', CHANNELS);
    expect(res.body.data).toBeFalsy();
  });

  it('never shows one property the channels of another', async () => {
    // The admin is ADMIN on both hotels. Under Alpha's scope they see SimTrip; under
    // Beta's — which has no channels — they see nothing. Same user, isolated by property.
    const alpha = await as('admin', CHANNELS, undefined, ALPHA);
    expect(alpha.body.data.channels.map((c: { code: string }) => c.code)).toContain('SIM_OTA');

    const beta = await as('admin', CHANNELS, undefined, BETA);
    expect(beta.body.data.channels).toEqual([]);
  });
});
