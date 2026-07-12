/**
 * Daily revenue report + trial balance (TDD §5.2, §6 step 5).
 *
 * The report a manager reads every morning and an accountant reads every month.
 * If it disagrees with the ledger, the books do not balance — so most of what is
 * asserted here is that the two agree.
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
const D0 = '2026-07-11';

let app: INestApplication;
let owner: postgres.Sql;
const tok: Record<string, string> = {};

let stdTypeId = '';
let planId = '';

function gql(query: string, variables?: unknown, token = tok['manager']) {
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

const REPORT = `
  query($d: String!) {
    dailyRevenueReport(date: $d) {
      businessDate currency
      revenue { code count amountMinor }
      payments { code count amountMinor }
      adjustments { code count amountMinor }
      roomRevenueMinor otherRevenueMinor taxMinor grossRevenueMinor
      paymentsMinor adjustmentsMinor
      outstandingMinor openFolios
      snapshot {
        roomsSold roomsAvailable occupancyBps adrMinor revparMinor
        roomRevenueMinor otherRevenueMinor taxMinor
      }
    }
  }
`;

async function checkedInStay(last: string) {
  const created = await gql(
    `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id rooms { id } } }`,
    {
      i: {
        guest: { firstName: 'Rep', lastName: last },
        source: 'DIRECT',
        arrivalDate: D0,
        departureDate: '2026-07-14',
        rooms: [{ roomTypeId: stdTypeId, ratePlanId: planId, adults: 1, children: 0 }],
      },
    },
    tok['frontdesk'],
  );

  const reservationId = created.body.data.createReservation.id as string;
  const lineId = created.body.data.createReservation.rooms[0].id as string;

  const [room] = await owner`
    SELECT id FROM inventory.rooms
    WHERE property_id = ${ALPHA} AND room_type_id = ${stdTypeId} AND status = 'VACANT_CLEAN'
      AND id NOT IN (
        SELECT room_id FROM reservations.reservation_rooms
        WHERE room_id IS NOT NULL AND status NOT IN ('CANCELLED','NO_SHOW')
      )
    LIMIT 1
  `;

  await gql(
    `mutation($i: AssignRoomGqlInput!) { assignRoom(input: $i) { id } }`,
    { i: { reservationRoomId: lineId, roomId: room!['id'] } },
    tok['frontdesk'],
  );

  const ci = await gql(
    `mutation($id: ID!) { checkIn(reservationId: $id) { folioId } }`,
    { id: reservationId },
    tok['frontdesk'],
  );

  return { reservationId, folioId: ci.body.data.checkIn.folioId as string };
}

const charge = (folioId: string, code: string, amountMinor: number) =>
  gql(
    `mutation($i: PostChargeGqlInput!) { postCharge(input: $i) { balance } }`,
    {
      i: { folioId, code, description: code, amountMinor, quantity: 1, currency: 'INR' },
    },
    tok['frontdesk'],
  );

const pay = (folioId: string, code: string, amountMinor: number) =>
  gql(
    `mutation($i: PostPaymentGqlInput!) { postPayment(input: $i) { balance } }`,
    { i: { folioId, code, amountMinor, currency: 'INR' } },
    tok['frontdesk'],
  );

async function wipe() {
  await owner`DELETE FROM reporting.daily_stats WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM shared.night_audit_runs WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM folio.invoices WHERE property_id = ${ALPHA}`;
  await owner.unsafe(`DELETE FROM folio.folio_lines WHERE property_id = '${ALPHA}'`);
  await owner`DELETE FROM folio.folios WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.reservation_rooms WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.reservations WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM reservations.room_type_availability WHERE property_id = ${ALPHA}`;
  await owner`DELETE FROM guests.guests WHERE property_id = ${ALPHA}`;
  await owner`UPDATE inventory.rooms SET status = 'VACANT_CLEAN'
              WHERE property_id = ${ALPHA} AND status IN ('OCCUPIED','VACANT_DIRTY')`;
  await owner`UPDATE property.properties SET business_date = ${D0} WHERE id = ${ALPHA}`;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  owner = ownerClient();
  for (const who of ['admin', 'manager', 'frontdesk', 'auditor', 'housekeeping']) {
    tok[who] = await login(`${who}@hotelos.dev`);
  }

  const [std] = await owner`SELECT id FROM inventory.room_types WHERE property_id=${ALPHA} AND code='STD'`;
  const [plan] = await owner`SELECT id FROM inventory.rate_plans WHERE property_id=${ALPHA} AND code='BAR'`;
  stdTypeId = std!['id'] as string;
  planId = plan!['id'] as string;

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

describe('daily revenue report', () => {
  it('is empty on a day with no trade', async () => {
    const res = await gql(REPORT, { d: D0 });
    const r = res.body.data.dailyRevenueReport;

    expect(r.revenue).toEqual([]);
    expect(r.grossRevenueMinor).toBe(0);
    expect(r.outstandingMinor).toBe(0);
    expect(r.snapshot).toBeNull(); // the audit has not run
  });

  it('breaks revenue down by code, net of tax', async () => {
    const stay = await checkedInStay('Revenue');

    await charge(stay.folioId, 'ROOM', 350_000);
    await charge(stay.folioId, 'F&B', 80_000);
    await charge(stay.folioId, 'LAUNDRY', 20_000);

    const res = await gql(REPORT, { d: D0 });
    const r = res.body.data.dailyRevenueReport;

    const byCode = Object.fromEntries(
      r.revenue.map((l: { code: string; amountMinor: number }) => [l.code, l.amountMinor]),
    );

    expect(byCode['ROOM']).toBe(350_000);
    expect(byCode['F&B']).toBe(80_000);
    expect(byCode['LAUNDRY']).toBe(20_000);

    expect(r.roomRevenueMinor).toBe(350_000);
    expect(r.otherRevenueMinor).toBe(100_000);

    // 12% on 450,000
    expect(r.taxMinor).toBe(54_000);

    // What the guest was actually billed.
    expect(r.grossRevenueMinor).toBe(450_000 + 54_000);
  });

  /**
   * Payments are stored NEGATIVE (they reduce what the guest owes). A report showing
   * "CASH −45,000" would be read as a refund by everyone who saw it.
   */
  it('reports payments POSITIVE, by method', async () => {
    const stay = await checkedInStay('Payments');

    await charge(stay.folioId, 'ROOM', 350_000);
    await pay(stay.folioId, 'CASH', 100_000);
    await pay(stay.folioId, 'CARD', 200_000);

    const res = await gql(REPORT, { d: D0 });
    const r = res.body.data.dailyRevenueReport;

    const byMethod = Object.fromEntries(
      r.payments.map((l: { code: string; amountMinor: number }) => [l.code, l.amountMinor]),
    );

    expect(byMethod['CASH']).toBe(100_000);
    expect(byMethod['CARD']).toBe(200_000);
    expect(r.paymentsMinor).toBe(300_000);
  });

  it('reports voids as adjustments and removes them from the balance', async () => {
    const stay = await checkedInStay('Voids');

    await charge(stay.folioId, 'F&B', 80_000);

    const folio = await gql(
      `query($id: ID!) { folio(id: $id) { lines { id type code } } }`,
      { id: stay.folioId },
      tok['frontdesk'],
    );
    const chargeLine = folio.body.data.folio.lines.find(
      (l: { type: string }) => l.type === 'CHARGE',
    );

    await gql(
      `mutation($i: VoidLineGqlInput!) { voidFolioLine(input: $i) { balance } }`,
      { i: { folioLineId: chargeLine.id, reason: 'Disputed' } },
      tok['manager'],
    );

    const res = await gql(REPORT, { d: D0 });
    const r = res.body.data.dailyRevenueReport;

    // The charge and its tax are both reversed, so the day nets to zero.
    expect(r.adjustmentsMinor).toBe(-(80_000 + 9_600));
    expect(r.grossRevenueMinor).toBe(0);
    expect(r.outstandingMinor).toBe(0);
  });
});

/**
 * The trial balance (TDD §6 step 5). If this disagrees with the ledger, something
 * has been posted that the report cannot see.
 */
describe('trial balance', () => {
  it('reports what guests in the building still owe', async () => {
    const a = await checkedInStay('OwesA');
    const b = await checkedInStay('OwesB');

    await charge(a.folioId, 'ROOM', 350_000); // 392,000 with tax
    await charge(b.folioId, 'ROOM', 350_000);
    await pay(b.folioId, 'CARD', 392_000); // B settles in full

    const res = await gql(REPORT, { d: D0 });
    const r = res.body.data.dailyRevenueReport;

    expect(r.openFolios).toBe(2);
    // A owes 392,000; B owes nothing.
    expect(r.outstandingMinor).toBe(392_000);
  });

  it('balances: charges + tax + adjustments − payments = outstanding', async () => {
    const a = await checkedInStay('BalA');
    const b = await checkedInStay('BalB');

    await charge(a.folioId, 'ROOM', 350_000);
    await charge(a.folioId, 'F&B', 45_678);
    await charge(b.folioId, 'ROOM', 350_000);
    await pay(a.folioId, 'UPI', 100_000);
    await pay(b.folioId, 'CASH', 50_000);

    const res = await gql(REPORT, { d: D0 });
    const r = res.body.data.dailyRevenueReport;

    /**
     * THE identity the whole report rests on. Everything billed today, minus
     * everything collected today, is what guests still owe — because every folio
     * opened today and none has closed.
     *
     * If this ever fails, the report is lying to an accountant.
     */
    expect(r.grossRevenueMinor - r.paymentsMinor).toBe(r.outstandingMinor);
  });

  it('excludes settled folios — a checked-out guest owes nothing', async () => {
    const stay = await checkedInStay('CheckedOut');

    await charge(stay.folioId, 'ROOM', 350_000);
    await pay(stay.folioId, 'CARD', 392_000);
    await gql(
      `mutation($id: ID!) { checkOut(reservationId: $id) { folioId } }`,
      { id: stay.reservationId },
      tok['frontdesk'],
    );

    const res = await gql(REPORT, { d: D0 });
    const r = res.body.data.dailyRevenueReport;

    // The revenue still counts for the day...
    expect(r.roomRevenueMinor).toBe(350_000);
    // ...but nobody is holding an open bill.
    expect(r.openFolios).toBe(0);
    expect(r.outstandingMinor).toBe(0);
  });
});

describe('the report and the night audit agree', () => {
  it('matches the frozen snapshot once the audit has run', async () => {
    await checkedInStay('AuditA');
    await checkedInStay('AuditB');

    await gql(`mutation { runNightAudit { status } }`);

    const res = await gql(REPORT, { d: D0 });
    const r = res.body.data.dailyRevenueReport;

    expect(r.snapshot).toBeTruthy();
    expect(r.snapshot.roomsSold).toBe(2);

    /**
     * The revenue report is computed live from the ledger; the snapshot was frozen
     * by the audit. They must agree — if they do not, one of them is lying about the
     * hotel's revenue, and there is no way to tell which.
     */
    expect(r.roomRevenueMinor).toBe(r.snapshot.roomRevenueMinor);
    expect(r.taxMinor).toBe(r.snapshot.taxMinor);
    expect(r.snapshot.adrMinor).toBe(350_000);
  });

  it('keys on BUSINESS date — a charge posted after the audit lands on the new day', async () => {
    const stay = await checkedInStay('Rollover');
    await gql(`mutation { runNightAudit { status } }`);

    // The trading day has rolled to 2026-07-12.
    await charge(stay.folioId, 'F&B', 30_000);

    const yesterday = (await gql(REPORT, { d: D0 })).body.data.dailyRevenueReport;
    const today = (await gql(REPORT, { d: '2026-07-12' })).body.data.dailyRevenueReport;

    // Yesterday's numbers are closed. They must not move.
    expect(yesterday.otherRevenueMinor).toBe(0);
    expect(today.otherRevenueMinor).toBe(30_000);
  });
});

describe('RBAC', () => {
  it('lets an auditor read the revenue report — that is their whole job', async () => {
    const res = await gql(REPORT, { d: D0 }, tok['auditor']);
    expect(res.body.errors).toBeFalsy();
  });

  it('refuses front desk and housekeeping — neither needs the hotel revenue', async () => {
    for (const who of ['frontdesk', 'housekeeping']) {
      const res = await gql(REPORT, { d: D0 }, tok[who]);
      expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
    }
  });
});
