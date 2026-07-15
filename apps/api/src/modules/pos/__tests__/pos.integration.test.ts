/**
 * POS (Phase 2): an order becomes a charge on a guest's bill.
 *
 * The module exists for one transition — OPEN → CHARGED — and most of this file is
 * about the ways that transition can bill the wrong person, bill them twice, or bill
 * them for nothing.
 *
 * Runs against the real API — real guards, real RLS, real transactions.
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
const D0 = '2026-07-11';

let app: INestApplication;
let owner: postgres.Sql;

const tokens: Record<string, string> = {};
let outletId = '';
let menu: Array<{ id: string; code: string; priceMinor: number }> = [];

function gql(query: string, variables?: unknown, opts: { token?: string; propertyId?: string } = {}) {
  const req = request(app.getHttpServer()).post('/graphql');
  if (opts.token) req.set('Authorization', `Bearer ${opts.token}`);
  if (opts.propertyId) req.set('X-Property-Id', opts.propertyId);
  return req.send({ query, variables });
}

function as(who: string, query: string, variables?: unknown) {
  return gql(query, variables, { token: tokens[who]!, propertyId: ALPHA });
}

async function login(email: string): Promise<string> {
  const res = await gql(`mutation($i: LoginInput!) { login(input: $i) { accessToken } }`, {
    i: { email, password: PASSWORD },
  });
  return res.body.data.login.accessToken;
}

const OPEN = `mutation($i: OpenOrderGqlInput!) { openOrder(input: $i) { id orderNo status subtotalMinor } }`;
const ADD = `mutation($i: AddOrderLineGqlInput!) { addOrderLine(input: $i) { id subtotalMinor lines { description quantity unitPriceMinor } } }`;
const REMOVE = `mutation($i: RemoveOrderLineGqlInput!) { removeOrderLine(input: $i) { id subtotalMinor lines { id } } }`;
const CHARGE = `mutation($i: ChargeOrderToRoomGqlInput!) { chargeOrderToRoom(input: $i) { roomNumber chargedMinor order { id status } } }`;
const VOID = `mutation($i: VoidOrderGqlInput!) { voidOrder(input: $i) { id status voidReason } }`;
const ROOMS = `{ chargeableRooms { roomId roomNumber guestName } }`;
const MENU = `query($o: ID!) { menu(outletId: $o) { id code name priceMinor } }`;

/** A guest checked into a room, with an open folio. The POS's whole reason to exist. */
async function checkedInGuest(last: string) {
  const room = await owner`
    SELECT r.id, r.number FROM inventory.rooms r
    JOIN inventory.room_types t ON t.id = r.room_type_id
    WHERE r.property_id = ${ALPHA} AND t.code = 'STD' AND r.status = 'VACANT_CLEAN'
      AND r.id NOT IN (
        SELECT room_id FROM reservations.reservation_rooms
        WHERE room_id IS NOT NULL AND status NOT IN ('CANCELLED','NO_SHOW')
      )
    ORDER BY r.number LIMIT 1
  `;

  const [typeRow] = await owner`SELECT id FROM inventory.room_types WHERE property_id = ${ALPHA} AND code = 'STD'`;
  const [planRow] = await owner`SELECT id FROM inventory.rate_plans WHERE property_id = ${ALPHA} LIMIT 1`;

  const created = await as(
    'frontdesk',
    `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id } }`,
    {
      i: {
        guest: { firstName: 'Dining', lastName: last },
        source: 'PHONE',
        arrivalDate: D0,
        departureDate: '2026-07-14',
        rooms: [{ roomTypeId: typeRow!['id'], ratePlanId: planRow!['id'], adults: 2, children: 0 }],
      },
    },
  );

  const reservationId = created.body.data.createReservation.id;

  const [rr] = await owner`
    SELECT id FROM reservations.reservation_rooms WHERE reservation_id = ${reservationId}
  `;

  await as(
    'frontdesk',
    `mutation($i: AssignRoomGqlInput!) { assignRoom(input: $i) { id } }`,
    { i: { reservationRoomId: rr!['id'], roomId: room[0]!['id'] } },
  );

  const ci = await as(
    'frontdesk',
    `mutation($id: ID!) { checkIn(reservationId: $id) { folioId } }`,
    { id: reservationId },
  );

  return {
    roomId: room[0]!['id'] as string,
    roomNumber: room[0]!['number'] as string,
    folioId: ci.body.data.checkIn.folioId as string,
    reservationId: reservationId as string,
  };
}

/** An open order with a ₹450 dal and two ₹90 naans on it = ₹630. */
async function orderWith(items: Array<[string, number]> = [['DAL', 1], ['NAAN', 2]]) {
  const opened = await as('pos', OPEN, { i: { outletId, tableRef: 'Table 4' } });

  if (!opened.body.data?.openOrder) {
    throw new Error(`openOrder failed: ${JSON.stringify(opened.body.errors)}`);
  }

  const orderId = opened.body.data.openOrder.id as string;

  for (const [code, quantity] of items) {
    const item = menu.find((m) => m.code === code)!;
    await as('pos', ADD, { i: { orderId, menuItemId: item.id, quantity } });
  }

  return orderId;
}

async function folioLines(folioId: string) {
  return owner`
    SELECT code, type, description, amount_minor FROM folio.folio_lines
    WHERE folio_id = ${folioId} ORDER BY created_at, type
  `;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  owner = ownerClient();

  for (const who of ['admin', 'manager', 'frontdesk', 'housekeeping', 'pos', 'auditor', 'beta.frontdesk']) {
    tokens[who] = await login(`${who}@hotelos.dev`);
  }

  const [outlet] = await owner`SELECT id FROM pos.outlets WHERE property_id = ${ALPHA} AND code = 'RESTAURANT'`;
  outletId = outlet!['id'] as string;

  const items = await as('pos', MENU, { o: outletId });
  menu = items.body.data.menu;
}, 90_000);

afterAll(async () => {
  await owner?.end();
  await app?.close();
});

beforeEach(async () => {
  await owner`DELETE FROM pos.order_lines WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM pos.orders WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM folio.folio_lines WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM folio.folios WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.reservation_rooms WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.reservations WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.room_type_availability WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM guests.guests WHERE property_id = ${ALPHA}`;
  await owner`UPDATE inventory.rooms SET status = 'VACANT_CLEAN'
              WHERE property_id = ${ALPHA} AND status IN ('OCCUPIED','VACANT_DIRTY')`;
  await owner`UPDATE property.properties SET business_date = ${D0} WHERE id = ${ALPHA}`;
});

// ── Taking an order ──────────────────────────────────────────────────────────

describe('taking an order', () => {
  it('prices the line from the MENU, not from the client', async () => {
    const orderId = await orderWith([['DAL', 1]]);

    const res = await as('pos', ADD, {
      i: { orderId, menuItemId: menu.find((m) => m.code === 'NAAN')!.id, quantity: 2 },
    });

    const lines = res.body.data.addOrderLine.lines;
    const naan = lines.find((l: { description: string }) => l.description === 'Butter Naan');

    // ₹90 from the seed. The caller never gets to say what a naan costs — there is no
    // price field on the input at all.
    expect(naan.unitPriceMinor).toBe(9_000);
    expect(res.body.data.addOrderLine.subtotalMinor).toBe(45_000 + 2 * 9_000); // ₹630
  });

  it('sums in minor units — a long tab loses nothing', async () => {
    const orderId = await orderWith([['BIRYANI', 3], ['LASSI', 2], ['GULAB', 1]]);
    const res = await as('pos', `query($id: ID!) { posOrder(orderId: $id) { subtotalMinor } }`, {
      id: orderId,
    });

    expect(res.body.data.posOrder.subtotalMinor).toBe(3 * 62_500 + 2 * 15_000 + 18_000);
  });

  it('lets a line be taken back off while the order is open', async () => {
    const orderId = await orderWith();

    const order = await as('pos', `query($id: ID!) { posOrder(orderId: $id) { lines { id } } }`, {
      id: orderId,
    });
    const lineId = order.body.data.posOrder.lines[0].id;

    const res = await as('pos', REMOVE, { i: { orderId, lineId } });
    expect(res.body.data.removeOrderLine.lines).toHaveLength(1);
  });

  it('refuses an item from another outlet', async () => {
    // Groundwork for a second outlet: the bar's whisky cannot go on the spa's tab.
    const orderId = await orderWith([]);

    const [other] = await owner`
      INSERT INTO pos.outlets (id, property_id, code, name, charge_code)
      VALUES (gen_random_uuid(), ${ALPHA}, 'BAR', 'The Long Bar', 'BAR')
      RETURNING id
    `;
    const [whisky] = await owner`
      INSERT INTO pos.menu_items (id, property_id, outlet_id, code, name, price_minor)
      VALUES (gen_random_uuid(), ${ALPHA}, ${other!['id']}, 'WHISKY', 'Single Malt', 120000)
      RETURNING id
    `;

    const res = await as('pos', ADD, {
      i: { orderId, menuItemId: whisky!['id'], quantity: 1 },
    });

    expect(res.body.errors?.[0]?.message).toMatch(/different outlet/i);

    await owner`DELETE FROM pos.menu_items WHERE id = ${whisky!['id']}`;
    await owner`DELETE FROM pos.outlets WHERE id = ${other!['id']}`;
  });
});

// ── Charging it to a room: the whole point ───────────────────────────────────

describe('charging an order to a room', () => {
  it('puts the meal AND its tax on the guest’s bill', async () => {
    const guest = await checkedInGuest('One');
    const orderId = await orderWith(); // ₹630

    const res = await as('pos', CHARGE, { i: { orderId, roomId: guest.roomId } });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.chargeOrderToRoom.roomNumber).toBe(guest.roomNumber);
    expect(res.body.data.chargeOrderToRoom.chargedMinor).toBe(63_000);
    expect(res.body.data.chargeOrderToRoom.order.status).toBe('CHARGED');

    const lines = await folioLines(guest.folioId);

    const charge = lines.find((l) => l['type'] === 'CHARGE');
    expect(charge!['code']).toBe('RESTAURANT');
    expect(Number(charge!['amount_minor'])).toBe(63_000);
    // The bill reads "Saffron · Order R-00001 (Table 4)", not fourteen lines of curry.
    expect(String(charge!['description'])).toMatch(/Saffron · Order R-\d+ \(Table 4\)/);

    // The TAX is the folio's, from the property's config — the POS has no opinion.
    const tax = lines.find((l) => l['type'] === 'TAX');
    expect(tax, 'the meal was billed with no GST').toBeTruthy();
    expect(Number(tax!['amount_minor'])).toBe(7_560); // 12% of ₹630
  });

  it('records WHERE it was charged, so the order and the bill agree', async () => {
    const guest = await checkedInGuest('Two');
    const orderId = await orderWith();

    await as('pos', CHARGE, { i: { orderId, roomId: guest.roomId } });

    const [order] = await owner`
      SELECT status, folio_id, room_id, charged_subtotal_minor, charged_at
      FROM pos.orders WHERE id = ${orderId}
    `;

    expect(order!['status']).toBe('CHARGED');
    expect(order!['folio_id']).toBe(guest.folioId);
    expect(order!['room_id']).toBe(guest.roomId);
    expect(Number(order!['charged_subtotal_minor'])).toBe(63_000);
    expect(order!['charged_at']).toBeTruthy();
  });

  it('REFUSES a room with nobody in it', async () => {
    // The classic. Room 204 is empty, and a mis-keyed room number bills a stranger —
    // or nobody, silently.
    const [empty] = await owner`
      SELECT id, number FROM inventory.rooms
      WHERE property_id = ${ALPHA} AND status = 'VACANT_CLEAN'
        AND id NOT IN (SELECT room_id FROM reservations.reservation_rooms WHERE room_id IS NOT NULL)
      LIMIT 1
    `;

    const orderId = await orderWith();

    const res = await as('pos', CHARGE, { i: { orderId, roomId: empty!['id'] } });

    expect(res.body.errors?.[0]?.message).toMatch(/no guest checked in/i);

    // And the order is untouched — still open, still chargeable to the right room.
    const [order] = await owner`SELECT status FROM pos.orders WHERE id = ${orderId}`;
    expect(order!['status']).toBe('OPEN');
  });

  it('REFUSES a room whose guest has checked out', async () => {
    // The room is still "theirs" in every naive sense — the reservation exists, the
    // room number is right — but they have gone, and their bill is closed. Billing it
    // charges a departed guest for someone else's dinner.
    const guest = await checkedInGuest('Departed');

    await owner`UPDATE reservations.reservations SET status = 'CHECKED_OUT' WHERE id = ${guest.reservationId}`;
    await owner`UPDATE folio.folios SET status = 'SETTLED' WHERE id = ${guest.folioId}`;

    const orderId = await orderWith();
    const res = await as('pos', CHARGE, { i: { orderId, roomId: guest.roomId } });

    expect(res.body.errors?.[0]?.message).toMatch(/no guest checked in/i);
  });

  it('REFUSES to charge an empty order', async () => {
    const guest = await checkedInGuest('Empty');
    const orderId = await orderWith([]);

    const res = await as('pos', CHARGE, { i: { orderId, roomId: guest.roomId } });
    expect(res.body.errors?.[0]?.message).toMatch(/nothing to charge/i);
  });

  it('NEVER charges the same order twice', async () => {
    // The double-tap on the waiter's tablet. The row is locked, then the state machine
    // refuses CHARGED → CHARGED.
    const guest = await checkedInGuest('Twice');
    const orderId = await orderWith();

    const first = await as('pos', CHARGE, { i: { orderId, roomId: guest.roomId } });
    expect(first.body.errors).toBeUndefined();

    const second = await as('pos', CHARGE, { i: { orderId, roomId: guest.roomId } });
    expect(second.body.errors?.[0]?.message).toMatch(/already on the guest/i);

    const lines = await folioLines(guest.folioId);
    const charges = lines.filter((l) => l['type'] === 'CHARGE');

    expect(charges, 'the guest was billed twice for one meal').toHaveLength(1);
  });

  it('is immutable once charged — no quiet edits after the guest has the bill', async () => {
    const guest = await checkedInGuest('Sealed');
    const orderId = await orderWith();

    await as('pos', CHARGE, { i: { orderId, roomId: guest.roomId } });

    const add = await as('pos', ADD, {
      i: { orderId, menuItemId: menu.find((m) => m.code === 'GULAB')!.id, quantity: 1 },
    });
    expect(add.body.errors?.[0]?.message).toMatch(/already on the guest|cannot be changed/i);

    const voided = await as('pos', VOID, { i: { orderId, reason: 'changed my mind' } });
    expect(voided.body.errors?.[0]?.message).toMatch(/already on the guest/i);

    // Still exactly what was billed.
    const lines = await folioLines(guest.folioId);
    expect(Number(lines.find((l) => l['type'] === 'CHARGE')!['amount_minor'])).toBe(63_000);
  });

  it('shows only the rooms that can actually be charged', async () => {
    const guest = await checkedInGuest('Listed');

    const res = await as('pos', ROOMS);
    const rooms = res.body.data.chargeableRooms;

    expect(rooms).toHaveLength(1);
    expect(rooms[0].roomNumber).toBe(guest.roomNumber);
    expect(rooms[0].guestName).toBe('Dining Listed');

    // A name and a room number. That is all a waiter needs to confirm the table.
    expect(Object.keys(rooms[0])).toEqual(['roomId', 'roomNumber', 'guestName']);
  });
});

// ── Voiding ──────────────────────────────────────────────────────────────────

describe('voiding an order', () => {
  it('cancels an order nobody was billed for', async () => {
    const orderId = await orderWith();

    const res = await as('pos', VOID, { i: { orderId, reason: 'Table left' } });

    expect(res.body.data.voidOrder.status).toBe('VOID');
    expect(res.body.data.voidOrder.voidReason).toBe('Table left');
  });

  it('demands a reason — a voided order with no reason is a missing till', async () => {
    const orderId = await orderWith();

    const res = await as('pos', VOID, { i: { orderId, reason: '' } });
    expect(res.body.errors?.[0]?.message).toMatch(/say why/i);
  });
});

// ── Authorization. The forbidden questions, from the first commit. ───────────

describe('RBAC — a waiter is not a cashier', () => {
  it('never hands the waiter a folio id or a balance', async () => {
    // The charge succeeds; what comes BACK is the point. A waiter who can read a
    // guest's balance can read every guest's balance.
    const guest = await checkedInGuest('Private');
    const orderId = await orderWith();

    const res = await as('pos', CHARGE, { i: { orderId, roomId: guest.roomId } });

    const body = JSON.stringify(res.body.data.chargeOrderToRoom);
    expect(body, 'the POS leaked the folio id to a waiter').not.toContain(guest.folioId);
    expect(body.toLowerCase()).not.toContain('balance');
  });

  it('refuses to let a waiter READ a guest’s folio', async () => {
    const guest = await checkedInGuest('Ledger');

    const res = await as('pos', `query($id: ID!) { folio(id: $id) { balanceMinor } }`, {
      id: guest.folioId,
    });

    expect(res.body.errors?.[0]?.message).toMatch(/permission|forbidden/i);
    expect(res.body.data?.folio ?? null).toBeNull();
  });

  it('refuses to let a waiter take a payment', async () => {
    const guest = await checkedInGuest('Cash');

    const res = await as(
      'pos',
      `mutation($i: PostPaymentGqlInput!) { postPayment(input: $i) { balance } }`,
      { i: { folioId: guest.folioId, code: 'CASH', amountMinor: 10_000, currency: 'INR' } },
    );

    // A REAL field, so the query actually executes and the guard actually runs. Asking
    // for a field that does not exist fails GraphQL validation before authorization is
    // ever consulted — and the test would pass without proving anything.
    expect(res.body.errors?.[0]?.message).toMatch(/permission|forbidden/i);

    // Nothing was taken.
    const [row] = await owner`
      SELECT count(*)::int AS n FROM folio.folio_lines
      WHERE folio_id = ${guest.folioId} AND type = 'PAYMENT'
    `;
    expect(Number(row!['n']), 'a waiter took a payment').toBe(0);
  });

  it('refuses to let a waiter check anybody in', async () => {
    const res = await as('pos', `mutation($id: ID!) { checkIn(reservationId: $id) { folioId } }`, {
      id: '00000000-0000-0000-0000-000000000000',
    });

    expect(res.body.errors?.[0]?.message).toMatch(/permission|forbidden/i);
  });

  it('refuses to let HOUSEKEEPING sell food', async () => {
    const res = await as('housekeeping', OPEN, { i: { outletId } });
    expect(res.body.errors?.[0]?.message).toMatch(/permission|forbidden/i);
  });

  it('refuses to let the AUDITOR touch the till', async () => {
    const orderId = await orderWith();

    for (const [name, mutation, vars] of [
      ['open', OPEN, { i: { outletId } }],
      ['void', VOID, { i: { orderId, reason: 'nope' } }],
    ] as const) {
      const res = await as('auditor', mutation, vars);
      expect(res.body.errors?.[0]?.message, `the auditor could ${name}`).toMatch(
        /permission|forbidden/i,
      );
    }
  });

  it('lets the FRONT DESK work the till — they take room-service orders', async () => {
    const res = await as('frontdesk', OPEN, { i: { outletId, tableRef: 'Room service' } });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.openOrder.status).toBe('OPEN');
  });
});

// ── Tenancy ──────────────────────────────────────────────────────────────────

describe('tenancy', () => {
  it("never shows one hotel's menu to another", async () => {
    const res = await gql(MENU, { o: outletId }, { token: tokens['beta.frontdesk']!, propertyId: BETA });

    // Alpha's outlet id, asked as Beta. RLS scopes it; there is nothing to see.
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.menu).toEqual([]);
  });

  it("refuses a Beta user asking for Alpha's till", async () => {
    const res = await gql(ROOMS, undefined, { token: tokens['beta.frontdesk']!, propertyId: ALPHA });
    expect(res.body.errors?.[0]?.message).toMatch(/access|permission|forbidden/i);
  });
});
