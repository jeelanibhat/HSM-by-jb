/**
 * Inventory: tenancy, room-status invariants, and the audit/event trail (TDD §4.2).
 *
 * Runs against the real API — real guards, real RLS, real transactions.
 * Assumes `pnpm db:migrate && pnpm db:seed`.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module';
import { ownerClient } from '../../../test/db';

const ALPHA = '11111111-1111-1111-1111-111111111111';
const BETA = '22222222-2222-2222-2222-222222222222';
const PASSWORD = 'Password123!';

let app: INestApplication;
let owner: postgres.Sql;

const tokens: Record<string, string> = {};

function gql(query: string, variables?: unknown, opts: { token?: string; propertyId?: string } = {}) {
  const req = request(app.getHttpServer()).post('/graphql');
  if (opts.token) req.set('Authorization', `Bearer ${opts.token}`);
  if (opts.propertyId) req.set('X-Property-Id', opts.propertyId);
  return req.send({ query, variables });
}

async function login(email: string): Promise<string> {
  const res = await gql(
    `mutation($i: LoginInput!) { login(input: $i) { accessToken } }`,
    { i: { email, password: PASSWORD } },
  );
  return res.body.data.login.accessToken;
}

const ROOMS = `{ rooms { id number status allowedTransitions } }`;
const ROOM_TYPES = `{ roomTypes { id code name } }`;
const UPDATE_STATUS = `
  mutation($i: UpdateRoomStatusGqlInput!) {
    updateRoomStatus(input: $i) { id number status allowedTransitions }
  }
`;

/** Grab a seeded Alpha room in a known status, straight from the DB. */
async function roomInStatus(status: string) {
  const [row] = await owner`
    SELECT id, number, status FROM inventory.rooms
    WHERE property_id = ${ALPHA} AND status = ${status}
    LIMIT 1
  `;
  return row as { id: string; number: string; status: string } | undefined;
}

async function setStatus(roomId: string, status: string) {
  await owner`UPDATE inventory.rooms SET status = ${status} WHERE id = ${roomId}`;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  owner = ownerClient();

  for (const who of [
    'admin',
    'manager',
    'frontdesk',
    'housekeeping',
    'auditor',
    'beta.frontdesk',
  ]) {
    tokens[who] = await login(`${who}@hotelos.dev`);
  }
}, 90_000);

afterAll(async () => {
  await owner?.end();
  await app?.close();
});

describe('tenancy — the new inventory schema is under RLS too', () => {
  it('shows Alpha its 30 seeded rooms', async () => {
    const res = await gql(ROOMS, undefined, { token: tokens['admin'], propertyId: ALPHA });
    expect(res.body.data.rooms).toHaveLength(30);
  });

  /**
   * The canary. Beta was seeded with NO inventory. If RLS on inventory.rooms were
   * missing — as it was for property.taxes before the superuser bug was found —
   * Beta would see Alpha's 30 rooms here.
   */
  it('shows Beta ZERO rooms — it owns none', async () => {
    const res = await gql(ROOMS, undefined, { token: tokens['admin'], propertyId: BETA });
    expect(res.body.data.rooms).toEqual([]);
  });

  it('shows Beta zero room types and zero rate plans', async () => {
    const types = await gql(ROOM_TYPES, undefined, { token: tokens['admin'], propertyId: BETA });
    const plans = await gql(`{ ratePlans { id code } }`, undefined, {
      token: tokens['admin'],
      propertyId: BETA,
    });

    expect(types.body.data.roomTypes).toEqual([]);
    expect(plans.body.data.ratePlans).toEqual([]);
  });

  it('refuses a Beta-only user asking for Alpha inventory', async () => {
    const res = await gql(ROOMS, undefined, {
      token: tokens['beta.frontdesk'],
      propertyId: ALPHA,
    });
    expect(res.body.errors).toBeTruthy();
  });
});

describe('RBAC', () => {
  const NEW_TYPE = `
    mutation($i: CreateRoomTypeGqlInput!) {
      createRoomType(input: $i) { id code }
    }
  `;

  it('lets a manager define a room type', async () => {
    const code = `T${Date.now() % 100000}`;

    const res = await gql(
      NEW_TYPE,
      { i: { code, name: 'Test', baseOccupancy: 2, maxOccupancy: 2 } },
      { token: tokens['manager'], propertyId: ALPHA },
    );
    expect(res.body.data.createRoomType.id).toBeTruthy();

    // Clean up after ourselves. Without this, every run leaves another orphan room
    // type in the dev database — the same "tests mutate shared state and never
    // tidy up" mistake that had the tenancy suite truncating identity.users.
    await owner`DELETE FROM inventory.room_types WHERE id = ${res.body.data.createRoomType.id}`;
  });

  it('refuses front desk defining inventory — that is an owner decision', async () => {
    const res = await gql(
      NEW_TYPE,
      { i: { code: 'NOPE', name: 'Nope', baseOccupancy: 2, maxOccupancy: 2 } },
      { token: tokens['frontdesk'], propertyId: ALPHA },
    );
    expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
  });

  it('refuses housekeeping moving rates — pricing is revenue management', async () => {
    const res = await gql(
      `mutation($i: SetRatePricesGqlInput!) { setRatePrices(input: $i) }`,
      {
        i: {
          ratePlanId: '00000000-0000-0000-0000-000000000000',
          roomTypeId: '00000000-0000-0000-0000-000000000000',
          from: '2026-07-11',
          to: '2026-07-12',
          priceMinor: 1,
        },
      },
      { token: tokens['housekeeping'], propertyId: ALPHA },
    );
    expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
  });

  /** Housekeeping turning rooms over IS the point of this endpoint. */
  it('lets housekeeping clean a dirty room', async () => {
    const room = await roomInStatus('VACANT_DIRTY');
    expect(room).toBeTruthy();

    const res = await gql(
      UPDATE_STATUS,
      { i: { roomId: room!.id, status: 'VACANT_CLEAN' } },
      { token: tokens['housekeeping'], propertyId: ALPHA },
    );

    expect(res.body.data.updateRoomStatus.status).toBe('VACANT_CLEAN');
    await setStatus(room!.id, 'VACANT_DIRTY'); // restore
  });

  it('refuses an auditor changing anything — read-only by definition', async () => {
    const room = await roomInStatus('VACANT_CLEAN');

    const res = await gql(
      UPDATE_STATUS,
      { i: { roomId: room!.id, status: 'VACANT_DIRTY' } },
      { token: tokens['auditor'], propertyId: ALPHA },
    );
    expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
  });
});

/**
 * The safety invariant. A guest is asleep in that room.
 */
describe('an occupied room cannot be taken out of order', () => {
  let occupied: { id: string; number: string };

  beforeEach(async () => {
    const room = await roomInStatus('VACANT_CLEAN');
    await setStatus(room!.id, 'OCCUPIED');
    occupied = { id: room!.id, number: room!.number };
  });

  it('rejects OOO on an occupied room, with a reason a human can act on', async () => {
    const res = await gql(
      UPDATE_STATUS,
      { i: { roomId: occupied.id, status: 'OOO', reason: 'Broken AC' } },
      { token: tokens['manager'], propertyId: ALPHA },
    );

    expect(res.body.errors).toBeTruthy();
    expect(res.body.errors[0].message).toMatch(/occupied room out of order/i);

    const [after] = await owner`SELECT status FROM inventory.rooms WHERE id = ${occupied.id}`;
    expect(after?.['status'], 'the room was taken OOO with a guest in it').toBe('OCCUPIED');

    await setStatus(occupied.id, 'VACANT_CLEAN');
  });

  it('does not even offer OOO/OOS as options for an occupied room', async () => {
    const res = await gql(ROOMS, undefined, { token: tokens['admin'], propertyId: ALPHA });
    const room = res.body.data.rooms.find((r: { id: string }) => r.id === occupied.id);

    expect(room.status).toBe('OCCUPIED');
    expect(room.allowedTransitions).toEqual([]);

    await setStatus(occupied.id, 'VACANT_CLEAN');
  });

  it('refuses a manual "mark occupied" — that is what check-in is for', async () => {
    await setStatus(occupied.id, 'VACANT_CLEAN');

    const res = await gql(
      UPDATE_STATUS,
      { i: { roomId: occupied.id, status: 'OCCUPIED' } },
      { token: tokens['manager'], propertyId: ALPHA },
    );

    expect(res.body.errors[0].message).toMatch(/checking a guest in/i);
  });
});

describe('room status changes are audited and evented', () => {
  it('writes an audit row and an outbox event in the same transaction', async () => {
    const room = await roomInStatus('VACANT_CLEAN');

    await owner`DELETE FROM shared.audit_log WHERE entity_id = ${room!.id}`;
    await owner`DELETE FROM shared.outbox_events WHERE aggregate_id = ${room!.id}`;

    const res = await gql(
      UPDATE_STATUS,
      { i: { roomId: room!.id, status: 'OOO', reason: 'Leaking shower' } },
      { token: tokens['manager'], propertyId: ALPHA },
    );
    expect(res.body.data.updateRoomStatus.status).toBe('OOO');

    const audits = await owner`
      SELECT * FROM shared.audit_log WHERE entity_id = ${room!.id} ORDER BY at DESC LIMIT 1
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.['action']).toBe('room.status_changed');
    expect(audits[0]?.['before']).toMatchObject({ status: 'VACANT_CLEAN' });
    expect(audits[0]?.['after']).toMatchObject({ status: 'OOO' });
    // Destructive/disruptive ops carry a reason (TDD §7.4).
    expect(audits[0]?.['reason']).toBe('Leaking shower');

    const events = await owner`
      SELECT * FROM shared.outbox_events WHERE aggregate_id = ${room!.id}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]?.['event_type']).toBe('room.status_changed');

    await setStatus(room!.id, 'VACANT_CLEAN');
  });

  /**
   * The rollback guarantee, exercised through a real mutation: an ILLEGAL
   * transition must leave no audit row and no phantom event behind.
   */
  it('leaves no audit row and no event when the transition is rejected', async () => {
    const room = await roomInStatus('VACANT_CLEAN');
    await setStatus(room!.id, 'OCCUPIED');

    await owner`DELETE FROM shared.audit_log WHERE entity_id = ${room!.id}`;
    await owner`DELETE FROM shared.outbox_events WHERE aggregate_id = ${room!.id}`;

    const res = await gql(
      UPDATE_STATUS,
      { i: { roomId: room!.id, status: 'OOO' } },
      { token: tokens['manager'], propertyId: ALPHA },
    );
    expect(res.body.errors).toBeTruthy();

    expect(await owner`SELECT 1 FROM shared.audit_log WHERE entity_id = ${room!.id}`).toHaveLength(0);
    expect(
      await owner`SELECT 1 FROM shared.outbox_events WHERE aggregate_id = ${room!.id}`,
      'phantom event emitted for a rejected status change',
    ).toHaveLength(0);

    await setStatus(room!.id, 'VACANT_CLEAN');
  });
});

describe('room numbering', () => {
  it('refuses a duplicate room number at the same property', async () => {
    const [type] = await owner`
      SELECT id FROM inventory.room_types WHERE property_id = ${ALPHA} AND code = 'STD'
    `;

    const res = await gql(
      `mutation($i: CreateRoomGqlInput!) { createRoom(input: $i) { id number } }`,
      { i: { roomTypeId: type!['id'], number: '101' } }, // 101 is already seeded
      { token: tokens['manager'], propertyId: ALPHA },
    );

    // Two rooms numbered 101 is how a guest ends up at the wrong door.
    expect(res.body.errors[0].message).toMatch(/already exists/i);
  });

  it('preserves a leading-zero room number as text, not an integer', async () => {
    const [type] = await owner`
      SELECT id FROM inventory.room_types WHERE property_id = ${ALPHA} AND code = 'STD'
    `;
    const number = `0${Math.floor(Math.random() * 900) + 100}`; // e.g. 0417

    const res = await gql(
      `mutation($i: CreateRoomGqlInput!) { createRoom(input: $i) { id number } }`,
      { i: { roomTypeId: type!['id'], number } },
      { token: tokens['manager'], propertyId: ALPHA },
    );

    expect(res.body.data.createRoom.number).toBe(number); // '0417', not '417'

    await owner`DELETE FROM inventory.rooms WHERE id = ${res.body.data.createRoom.id}`;
  });
});

describe('rate grid', () => {
  it('prices a date range inclusively and upserts on re-pricing', async () => {
    const [plan] = await owner`
      SELECT id FROM inventory.rate_plans WHERE property_id = ${ALPHA} AND code = 'BAR'
    `;
    const [type] = await owner`
      SELECT id FROM inventory.room_types WHERE property_id = ${ALPHA} AND code = 'STD'
    `;

    const input = {
      ratePlanId: plan!['id'],
      roomTypeId: type!['id'],
      from: '2027-01-01',
      to: '2027-01-05',
      priceMinor: 400_000,
    };

    const first = await gql(
      `mutation($i: SetRatePricesGqlInput!) { setRatePrices(input: $i) }`,
      { i: input },
      { token: tokens['manager'], propertyId: ALPHA },
    );
    // Inclusive: Jan 1..5 is five days, not four.
    expect(first.body.data.setRatePrices).toBe(5);

    // Re-pricing the same dates must UPDATE, not blow up on the unique index —
    // revenue managers change rates constantly.
    const second = await gql(
      `mutation($i: SetRatePricesGqlInput!) { setRatePrices(input: $i) }`,
      { i: { ...input, priceMinor: 450_000 } },
      { token: tokens['manager'], propertyId: ALPHA },
    );
    expect(second.body.data.setRatePrices).toBe(5);

    const rows = await owner`
      SELECT price_minor FROM inventory.rate_prices
      WHERE rate_plan_id = ${plan!['id']} AND room_type_id = ${type!['id']}
        AND date BETWEEN '2027-01-01' AND '2027-01-05'
    `;
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => Number(r['price_minor']) === 450_000)).toBe(true);

    await owner`
      DELETE FROM inventory.rate_prices
      WHERE date BETWEEN '2027-01-01' AND '2027-01-05' AND rate_plan_id = ${plan!['id']}
    `;
  });

  it('rejects a negative price at the DB level as well as in zod', async () => {
    await expect(
      owner`
        INSERT INTO inventory.rate_prices (id, property_id, rate_plan_id, room_type_id, date, price_minor)
        SELECT gen_random_uuid(), ${ALPHA}, rp.id, rt.id, '2027-02-01', -100
        FROM inventory.rate_plans rp, inventory.room_types rt
        WHERE rp.property_id = ${ALPHA} AND rt.property_id = ${ALPHA} LIMIT 1
      `,
    ).rejects.toThrow(/rate_prices_non_negative/);
  });
});
