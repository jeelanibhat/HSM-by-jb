/**
 * Folio + check-in/out (TDD steps 8–9).
 *
 * §8.2 asks for folio math to be exhaustive: "tax calculation (inclusive/exclusive),
 * split folios, void reversals sum to zero, settlement balance".
 *
 * §8.3 case 1 is the whole arc: create → assign → check-in → post charge → post
 * payment → check-out → verify folio settled. It is the last test in this file.
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
const PASSWORD = 'Password123!';

let app: INestApplication;
let owner: postgres.Sql;
const tok: Record<string, string> = {};

let stdTypeId = '';
let planId = '';

function gql(query: string, variables?: unknown, token = tok['frontdesk']) {
  return request(app.getHttpServer())
    .post('/graphql')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Property-Id', ALPHA)
    .send({ query, variables });
}

async function login(email: string) {
  const res = await request(app.getHttpServer())
    .post('/graphql')
    .send({
      query: `mutation($i: LoginInput!) { login(input: $i) { accessToken } }`,
      variables: { i: { email, password: PASSWORD } },
    });
  return res.body.data.login.accessToken as string;
}

const CHECK_IN = `mutation($id: ID!) { checkIn(reservationId: $id) { folioId reservation { status } } }`;
const CHECK_OUT = `mutation($id: ID!) { checkOut(reservationId: $id) { folioId reservation { status } } }`;
const CHARGE = `mutation($i: PostChargeGqlInput!) { postCharge(input: $i) { charges payments tax balance currency } }`;
const PAYMENT = `mutation($i: PostPaymentGqlInput!) { postPayment(input: $i) { charges payments tax balance currency } }`;
const VOID = `mutation($i: VoidLineGqlInput!) { voidFolioLine(input: $i) { balance } }`;
const FOLIO = `
  query($id: ID!) {
    folio(id: $id) {
      id folioNo status balanceMinor currency
      lines { id type code description amountMinor taxAmountMinor voided reversesLineId reason }
    }
  }
`;

/** A booking, a room, checked in. Returns reservation + folio ids. */
async function stayCheckedIn(last = 'Guest') {
  const created = await gql(
    `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id rooms { id } } }`,
    {
      i: {
        guest: { firstName: 'Test', lastName: last },
        source: 'DIRECT',
        arrivalDate: '2026-07-12',
        departureDate: '2026-07-15',
        rooms: [{ roomTypeId: stdTypeId, ratePlanId: planId, adults: 1, children: 0 }],
      },
    },
  );

  const reservationId = created.body.data.createReservation.id as string;
  const lineId = created.body.data.createReservation.rooms[0].id as string;

  const [room] = await owner`
    SELECT id FROM inventory.rooms
    WHERE property_id = ${ALPHA} AND room_type_id = ${stdTypeId}
      AND status = 'VACANT_CLEAN'
      AND id NOT IN (
        SELECT room_id FROM reservations.reservation_rooms
        WHERE room_id IS NOT NULL AND status NOT IN ('CANCELLED','NO_SHOW')
      )
    LIMIT 1
  `;

  await gql(
    `mutation($i: AssignRoomGqlInput!) { assignRoom(input: $i) { id } }`,
    { i: { reservationRoomId: lineId, roomId: room!['id'] } },
  );

  const ci = await gql(CHECK_IN, { id: reservationId });

  return {
    reservationId,
    folioId: ci.body.data?.checkIn?.folioId as string,
    roomId: room!['id'] as string,
    response: ci,
  };
}

async function wipe() {
  await owner`DELETE FROM folio.invoices WHERE property_id = ${ALPHA}`;
  await owner.unsafe(`
    SET session_replication_role = replica;
    DELETE FROM folio.folio_lines WHERE property_id = '${ALPHA}';
    SET session_replication_role = DEFAULT;
  `);
  await owner`DELETE FROM folio.folios WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.reservation_rooms WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.reservations WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.room_type_availability WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM guests.guests WHERE property_id = ${ALPHA}`;
  await owner`UPDATE inventory.rooms SET status = 'VACANT_CLEAN'
              WHERE property_id = ${ALPHA} AND status IN ('OCCUPIED','VACANT_DIRTY')`;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  owner = ownerClient();
  for (const who of ['admin', 'manager', 'frontdesk', 'housekeeping']) {
    tok[who] = await login(`${who}@hotelos.dev`);
  }

  const [std] = await owner`SELECT id FROM inventory.room_types WHERE property_id=${ALPHA} AND code='STD'`;
  const [plan] = await owner`SELECT id FROM inventory.rate_plans WHERE property_id=${ALPHA} AND code='BAR'`;
  stdTypeId = std!['id'] as string;
  planId = plan!['id'] as string;

  // Alpha's seed has GST 12% EXCLUSIVE.
  await wipe();
}, 90_000);

afterAll(async () => {
  await wipe();
  await owner?.end();
  await app?.close();
});

beforeEach(async () => {
  await wipe();
});

describe('check-in', () => {
  it('moves reservation → CHECKED_IN, room → OCCUPIED, and opens a folio', async () => {
    const stay = await stayCheckedIn();

    expect(stay.response.body.data.checkIn.reservation.status).toBe('CHECKED_IN');
    expect(stay.folioId).toBeTruthy();

    const [room] = await owner`SELECT status FROM inventory.rooms WHERE id = ${stay.roomId}`;
    expect(room?.['status']).toBe('OCCUPIED');

    const folio = await gql(FOLIO, { id: stay.folioId });
    expect(folio.body.data.folio.status).toBe('OPEN');
    expect(folio.body.data.folio.balanceMinor).toBe(0);
    expect(folio.body.data.folio.folioNo).toMatch(/^F-\d+$/);
  });

  it('REFUSES to check in without a room assigned', async () => {
    const created = await gql(
      `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id } }`,
      {
        i: {
          guest: { firstName: 'No', lastName: 'Room' },
          source: 'DIRECT',
          arrivalDate: '2026-07-12',
          departureDate: '2026-07-14',
          rooms: [{ roomTypeId: stdTypeId, ratePlanId: planId, adults: 1, children: 0 }],
        },
      },
    );

    const res = await gql(CHECK_IN, { id: created.body.data.createReservation.id });

    // Selling a room type is not the same as putting someone in a room — and the
    // exclusion constraint only protects an ASSIGNED room.
    expect(res.body.errors[0].message).toMatch(/assign a room before checking in/i);
  });

  it('refuses to check in twice', async () => {
    const stay = await stayCheckedIn();

    const again = await gql(CHECK_IN, { id: stay.reservationId });
    expect(again.body.errors[0].message).toMatch(/cannot check in a checked in/i);
  });

  it('refuses to check in a cancelled reservation', async () => {
    const created = await gql(
      `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id rooms { id } } }`,
      {
        i: {
          guest: { firstName: 'Gone', lastName: 'Away' },
          source: 'DIRECT',
          arrivalDate: '2026-07-12',
          departureDate: '2026-07-14',
          rooms: [{ roomTypeId: stdTypeId, ratePlanId: planId, adults: 1, children: 0 }],
        },
      },
    );
    const id = created.body.data.createReservation.id;

    await gql(`mutation($i: CancelReservationGqlInput!) { cancelReservation(input: $i) { id } }`, {
      i: { reservationId: id, reason: 'Changed plans' },
    });

    const res = await gql(CHECK_IN, { id });
    expect(res.body.errors[0].message).toMatch(/cannot check in a cancelled/i);
  });
});

/**
 * §8.2: "tax calculation (inclusive/exclusive)".
 */
describe('charges and tax', () => {
  it('posts a charge and its tax as SEPARATE lines', async () => {
    const stay = await stayCheckedIn();

    // ₹3,500 room. Alpha has GST 12% EXCLUSIVE.
    const res = await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Room charge',
        amountMinor: 350_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const balance = res.body.data.postCharge;
    expect(balance.balance).toBe(392_000); // 350000 + 42000 GST
    expect(balance.tax).toBe(42_000);

    const folio = await gql(FOLIO, { id: stay.folioId });
    const lines = folio.body.data.folio.lines;

    // An invoice must show "Room 3,500 / GST 12% 420". A single 3,920 line cannot
    // be decomposed back into those without guessing.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: 'CHARGE', code: 'ROOM', amountMinor: 350_000 });
    expect(lines[1]).toMatchObject({ type: 'TAX', amountMinor: 42_000 });
  });

  it('multiplies by quantity before taxing', async () => {
    const stay = await stayCheckedIn();

    const res = await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'Beer',
        amountMinor: 25_000, // ₹250
        quantity: 3,
        currency: 'INR',
      },
    });

    // 75000 + 12% = 84000
    expect(res.body.data.postCharge.balance).toBe(84_000);
    expect(res.body.data.postCharge.tax).toBe(9_000);
  });

  it('carves INCLUSIVE tax OUT of the quoted price', async () => {
    // Switch Alpha's GST to inclusive for this test.
    await owner`UPDATE property.taxes SET type = 'INCLUSIVE' WHERE property_id = ${ALPHA}`;

    try {
      const stay = await stayCheckedIn();

      // ₹3,920 is what the guest was QUOTED, tax already inside.
      const res = await gql(CHARGE, {
        i: {
          folioId: stay.folioId,
          code: 'ROOM',
          description: 'Room (rack rate, GST inclusive)',
          amountMinor: 392_000,
          quantity: 1,
          currency: 'INR',
        },
      });

      // The guest still pays exactly what they were quoted...
      expect(res.body.data.postCharge.balance).toBe(392_000);
      // ...but the bill correctly splits it 3,500 + 420.
      expect(res.body.data.postCharge.tax).toBe(42_000);

      const folio = await gql(FOLIO, { id: stay.folioId });
      const lines = folio.body.data.folio.lines;

      expect(lines[0].amountMinor).toBe(350_000); // net, carved out
      expect(lines[1].amountMinor).toBe(42_000);

      // Getting this backwards would charge the guest 4,390 — the tax applied to a
      // price that already contained it.
      expect(lines[0].amountMinor + lines[1].amountMinor).toBe(392_000);
    } finally {
      await owner`UPDATE property.taxes SET type = 'EXCLUSIVE' WHERE property_id = ${ALPHA}`;
    }
  });

  it('rejects a zero or negative charge', async () => {
    const stay = await stayCheckedIn();

    const res = await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Free?',
        amountMinor: 0,
        quantity: 1,
        currency: 'INR',
      },
    });
    expect(res.body.errors).toBeTruthy();
  });
});

describe('payments', () => {
  it('reduces the balance', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Room',
        amountMinor: 350_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const res = await gql(PAYMENT, {
      i: { folioId: stay.folioId, code: 'CARD', amountMinor: 392_000, currency: 'INR' },
    });

    expect(res.body.data.postPayment.balance).toBe(0);
    expect(res.body.data.postPayment.payments).toBe(-392_000);
  });

  it('stores a payment as a NEGATIVE line, whatever sign is sent', async () => {
    const stay = await stayCheckedIn();

    await gql(PAYMENT, {
      i: { folioId: stay.folioId, code: 'CASH', amountMinor: 100_000, currency: 'INR' },
    });

    const [line] = await owner`
      SELECT amount_minor FROM folio.folio_lines
      WHERE folio_id = ${stay.folioId} AND type = 'PAYMENT'
    `;

    // A payment that increases what the guest owes is a bug, not a payment.
    expect(Number(line!['amount_minor'])).toBe(-100_000);
  });

  it('handles partial payments', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Room',
        amountMinor: 350_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const first = await gql(PAYMENT, {
      i: { folioId: stay.folioId, code: 'CASH', amountMinor: 200_000, currency: 'INR' },
    });
    expect(first.body.data.postPayment.balance).toBe(192_000);

    const second = await gql(PAYMENT, {
      i: { folioId: stay.folioId, code: 'UPI', amountMinor: 192_000, currency: 'INR' },
    });
    expect(second.body.data.postPayment.balance).toBe(0);
  });
});

/**
 * §8.2: "void reversals sum to zero". §6: "Folio lines are immutable".
 */
describe('voids are reversals, never edits', () => {
  it('leaves the original line untouched and adds a reversing entry', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'Minibar',
        amountMinor: 50_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const before = await gql(FOLIO, { id: stay.folioId });
    const chargeLine = before.body.data.folio.lines.find(
      (l: { type: string }) => l.type === 'CHARGE',
    );
    expect(before.body.data.folio.balanceMinor).toBe(56_000);

    const voided = await gql(
      VOID,
      { i: { folioLineId: chargeLine.id, reason: 'Guest disputed the minibar' } },
      tok['manager'],
    );

    /**
     * THE ASSERTION THAT CAUGHT THE BUG.
     *
     * The first version of this checked only that the charge and its reversal summed
     * to zero — and they did. The 6,000 of GST on the voided charge was still sitting
     * in the balance, and the test was perfectly happy. The guest would have paid tax
     * on a line that no longer existed, and the hotel would have remitted tax it never
     * collected.
     *
     * Assert on the BALANCE, which is what the guest actually pays.
     */
    expect(
      voided.body.data.voidFolioLine.balance,
      'voiding a charge left its tax behind — the guest is paying GST on a line that does not exist',
    ).toBe(0);

    const after = await gql(FOLIO, { id: stay.folioId });
    const lines = after.body.data.folio.lines;

    // The ORIGINAL is still there, unchanged, and marked as voided.
    const original = lines.find((l: { id: string }) => l.id === chargeLine.id);
    expect(original.amountMinor).toBe(50_000); // NOT zeroed, NOT deleted
    expect(original.voided).toBe(true);

    // The reversal is a new, separate line.
    const reversal = lines.find(
      (l: { reversesLineId?: string }) => l.reversesLineId === chargeLine.id,
    );
    expect(reversal.amountMinor).toBe(-50_000);
    expect(reversal.reason).toBe('Guest disputed the minibar');
    expect(reversal.type).toBe('ADJUSTMENT');

    // ...and the TAX was reversed too, as its own line.
    const taxLine = lines.find((l: { type: string }) => l.type === 'TAX');
    const taxReversal = lines.find(
      (l: { reversesLineId?: string }) => l.reversesLineId === taxLine.id,
    );

    expect(taxReversal, 'the tax on the voided charge was never reversed').toBeTruthy();
    expect(taxReversal.amountMinor).toBe(-6_000);
    expect(taxLine.voided).toBe(true);
  });

  it('refuses to void a TAX line on its own', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'Dinner',
        amountMinor: 40_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const folio = await gql(FOLIO, { id: stay.folioId });
    const tax = folio.body.data.folio.lines.find((l: { type: string }) => l.type === 'TAX');

    // "The charge stands but the tax on it does not" is either fraud or a bug.
    const res = await gql(
      VOID,
      { i: { folioLineId: tax.id, reason: 'Just remove the tax' } },
      tok['manager'],
    );
    expect(res.body.errors[0].message).toMatch(/tax cannot be voided on its own/i);
  });

  /**
   * §8.2: "void reversals sum to zero". Note this is asserted on the BALANCE — the
   * number the guest pays — not on individual line pairs, which can each sum to zero
   * while the folio still carries an orphaned tax line.
   */
  it('voiding every charge takes the folio to exactly zero, tax included', async () => {
    const stay = await stayCheckedIn();

    // An awkward amount, so a rounding bug in the tax split shows up.
    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'LAUNDRY',
        description: 'Laundry',
        amountMinor: 12_345,
        quantity: 1,
        currency: 'INR',
      },
    });
    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'Dinner',
        amountMinor: 67_891,
        quantity: 1,
        currency: 'INR',
      },
    });

    const folio = await gql(FOLIO, { id: stay.folioId });
    expect(folio.body.data.folio.balanceMinor).toBeGreaterThan(0);

    // Void the CHARGES only — the tax goes with each one automatically.
    const charges = folio.body.data.folio.lines.filter(
      (l: { type: string }) => l.type === 'CHARGE',
    );

    for (const line of charges) {
      await gql(VOID, { i: { folioLineId: line.id, reason: 'Void everything' } }, tok['manager']);
    }

    const after = await gql(FOLIO, { id: stay.folioId });
    expect(
      after.body.data.folio.balanceMinor,
      'the folio did not return to zero — an orphaned tax line is left behind',
    ).toBe(0);
  });

  it('refuses to void the same line twice — a double-click must not pay the guest', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'Dinner',
        amountMinor: 80_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const folio = await gql(FOLIO, { id: stay.folioId });
    const line = folio.body.data.folio.lines[0];

    await gql(VOID, { i: { folioLineId: line.id, reason: 'First' } }, tok['manager']);
    const second = await gql(
      VOID,
      { i: { folioLineId: line.id, reason: 'Second' } },
      tok['manager'],
    );

    expect(second.body.errors[0].message).toMatch(/already been voided/i);
  });

  it('refuses to void a reversal', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'Lunch',
        amountMinor: 30_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const folio = await gql(FOLIO, { id: stay.folioId });
    const charge = folio.body.data.folio.lines[0];

    await gql(VOID, { i: { folioLineId: charge.id, reason: 'Void' } }, tok['manager']);

    const after = await gql(FOLIO, { id: stay.folioId });
    const reversal = after.body.data.folio.lines.find(
      (l: { reversesLineId?: string }) => l.reversesLineId,
    );

    const res = await gql(
      VOID,
      { i: { folioLineId: reversal.id, reason: 'Un-void it' } },
      tok['manager'],
    );
    expect(res.body.errors[0].message).toMatch(/itself a reversal/i);
  });

  it('requires a reason', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'X',
        amountMinor: 1000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const folio = await gql(FOLIO, { id: stay.folioId });

    const res = await gql(
      VOID,
      { i: { folioLineId: folio.body.data.folio.lines[0].id, reason: '' } },
      tok['manager'],
    );
    expect(res.body.errors).toBeTruthy();
  });

  it('is manager-only — a front desk agent asks someone to reverse a charge', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'X',
        amountMinor: 1000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const folio = await gql(FOLIO, { id: stay.folioId });

    const res = await gql(VOID, {
      i: { folioLineId: folio.body.data.folio.lines[0].id, reason: 'Mistake' },
    }); // front desk token
    expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
  });
});

/**
 * The ledger is append-only IN THE DATABASE, not just in our code.
 */
describe('the database itself refuses to rewrite history', () => {
  it('denies UPDATE on a folio line to the app role', async () => {
    const stay = await stayCheckedIn();
    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Room',
        amountMinor: 100_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const appRole = (await import('../../../test/db')).appClient();

    try {
      await expect(
        appRole`UPDATE folio.folio_lines SET amount_minor = 1 WHERE folio_id = ${stay.folioId}`,
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await appRole.end();
    }
  });

  it('denies DELETE on a folio line to the app role', async () => {
    const stay = await stayCheckedIn();
    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Room',
        amountMinor: 100_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const appRole = (await import('../../../test/db')).appClient();

    try {
      await expect(
        appRole`DELETE FROM folio.folio_lines WHERE folio_id = ${stay.folioId}`,
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await appRole.end();
    }
  });
});

/**
 * §6: "Check-out requires folio balance == 0".
 */
describe('check-out refuses an unsettled folio', () => {
  it('BLOCKS check-out with an outstanding balance, naming the amount', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Room',
        amountMinor: 350_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const res = await gql(CHECK_OUT, { id: stay.reservationId });

    expect(res.body.errors[0].message).toMatch(/outstanding balance/i);
    expect(res.body.errors[0].message).toContain('3920.00');

    // Nothing moved. The guest is still in the room.
    const [room] = await owner`SELECT status FROM inventory.rooms WHERE id = ${stay.roomId}`;
    expect(room?.['status']).toBe('OCCUPIED');

    const [res2] = await owner`
      SELECT status FROM reservations.reservations WHERE id = ${stay.reservationId}
    `;
    expect(res2?.['status']).toBe('CHECKED_IN');
  });

  it('BLOCKS check-out on an OVERPAID folio rather than silently keeping the money', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Room',
        amountMinor: 100_000,
        quantity: 1,
        currency: 'INR',
      },
    });
    await gql(PAYMENT, {
      i: { folioId: stay.folioId, code: 'CASH', amountMinor: 200_000, currency: 'INR' },
    });

    const res = await gql(CHECK_OUT, { id: stay.reservationId });
    expect(res.body.errors[0].message).toMatch(/overpaid/i);
  });

  it('ALLOWS check-out at exactly zero', async () => {
    const stay = await stayCheckedIn();

    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Room',
        amountMinor: 350_000,
        quantity: 1,
        currency: 'INR',
      },
    });
    await gql(PAYMENT, {
      i: { folioId: stay.folioId, code: 'CARD', amountMinor: 392_000, currency: 'INR' },
    });

    const res = await gql(CHECK_OUT, { id: stay.reservationId });
    expect(res.body.data.checkOut.reservation.status).toBe('CHECKED_OUT');
  });

  it('leaves the room VACANT_DIRTY, not clean — nobody has cleaned it yet', async () => {
    const stay = await stayCheckedIn();
    await gql(CHECK_OUT, { id: stay.reservationId }); // zero balance

    const [room] = await owner`SELECT status FROM inventory.rooms WHERE id = ${stay.roomId}`;
    expect(room?.['status']).toBe('VACANT_DIRTY');
  });

  it('closes the folio so nothing more can be posted to it', async () => {
    const stay = await stayCheckedIn();
    await gql(CHECK_OUT, { id: stay.reservationId });

    const folio = await gql(FOLIO, { id: stay.folioId });
    expect(folio.body.data.folio.status).toBe('SETTLED');

    const late = await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'Late minibar',
        amountMinor: 10_000,
        quantity: 1,
        currency: 'INR',
      },
    });
    expect(late.body.errors[0].message).toMatch(/settled and cannot be posted to/i);
  });

  it('refuses to check out a reservation that never checked in', async () => {
    const created = await gql(
      `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id } }`,
      {
        i: {
          guest: { firstName: 'Never', lastName: 'Arrived' },
          source: 'DIRECT',
          arrivalDate: '2026-07-12',
          departureDate: '2026-07-14',
          rooms: [{ roomTypeId: stdTypeId, ratePlanId: planId, adults: 1, children: 0 }],
        },
      },
    );

    const res = await gql(CHECK_OUT, { id: created.body.data.createReservation.id });
    expect(res.body.errors[0].message).toMatch(/cannot check out a confirmed/i);
  });
});

describe('RBAC — housekeeping cannot access cashiering (E2E case 6)', () => {
  it('refuses housekeeping posting a charge', async () => {
    const stay = await stayCheckedIn();

    const res = await gql(
      CHARGE,
      {
        i: {
          folioId: stay.folioId,
          code: 'F&B',
          description: 'X',
          amountMinor: 1000,
          quantity: 1,
          currency: 'INR',
        },
      },
      tok['housekeeping'],
    );
    expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
  });

  it('refuses housekeeping taking a payment', async () => {
    const stay = await stayCheckedIn();

    const res = await gql(
      PAYMENT,
      { i: { folioId: stay.folioId, code: 'CASH', amountMinor: 1000, currency: 'INR' } },
      tok['housekeeping'],
    );
    expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
  });
});

/**
 * TDD §8.3, E2E case 1 — the whole business, end to end.
 */
describe('the critical path (E2E case 1)', () => {
  it('create → assign → check-in → charge → pay → check-out → folio settled', async () => {
    const stay = await stayCheckedIn('CriticalPath');
    expect(stay.folioId).toBeTruthy();

    // Three nights at ₹3,500.
    const charged = await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'ROOM',
        description: 'Room · 3 nights',
        amountMinor: 350_000,
        quantity: 3,
        currency: 'INR',
      },
    });
    expect(charged.body.data.postCharge.balance).toBe(1_176_000); // 1,050,000 + 12%

    // A bar tab.
    await gql(CHARGE, {
      i: {
        folioId: stay.folioId,
        code: 'F&B',
        description: 'Bar',
        amountMinor: 50_000,
        quantity: 1,
        currency: 'INR',
      },
    });

    const folioBefore = await gql(FOLIO, { id: stay.folioId });
    const owed = folioBefore.body.data.folio.balanceMinor;
    expect(owed).toBe(1_176_000 + 56_000);

    // Guest settles.
    const paid = await gql(PAYMENT, {
      i: {
        folioId: stay.folioId,
        code: 'CARD',
        amountMinor: owed,
        currency: 'INR',
        reference: 'VISA ••4242',
      },
    });
    expect(paid.body.data.postPayment.balance).toBe(0);

    const out = await gql(CHECK_OUT, { id: stay.reservationId });
    expect(out.body.data.checkOut.reservation.status).toBe('CHECKED_OUT');

    const folio = await gql(FOLIO, { id: stay.folioId });
    expect(folio.body.data.folio.status).toBe('SETTLED');
    expect(folio.body.data.folio.balanceMinor).toBe(0);

    const [room] = await owner`SELECT status FROM inventory.rooms WHERE id = ${stay.roomId}`;
    expect(room?.['status']).toBe('VACANT_DIRTY');

    // The whole arc is in the audit log.
    const audits = await owner`
      SELECT action FROM shared.audit_log
      WHERE entity_id IN (${stay.reservationId}, ${stay.folioId})
      ORDER BY at
    `;
    const actions = audits.map((a) => a['action']);
    expect(actions).toContain('reservation.checked_in');
    expect(actions).toContain('folio.opened');
    expect(actions).toContain('reservation.checked_out');
    expect(actions).toContain('folio.settled');
  });
});
