/**
 * Night audit (TDD §6, step 10).
 *
 * §8.2 demands: "Night audit steps: idempotency (re-running a step is a no-op),
 * failure mid-run resume."
 *
 * The nightmare this suite exists to prevent: the audit dies half way through at
 * 3am, an exhausted operator re-runs it, and every in-house guest is charged twice
 * for the same night.
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

/** The seeded business date. */
const D0 = '2026-07-11';
const D1 = '2026-07-12';

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

const RUN = `
  mutation {
    runNightAudit {
      runId businessDate newBusinessDate status
      steps { step status detail }
    }
  }
`;
const STATS = `
  query($f: String!, $t: String!) {
    occupancyReport(from: $f, to: $t) {
      businessDate roomsAvailable roomsSold occupancyBps roomRevenueMinor adrMinor revparMinor
    }
  }
`;
const FOLIO = `query($id: ID!) { folio(id: $id) { balanceMinor lines { type code businessDate amountMinor } } }`;

/** A stay, checked in, spanning the audit night. */
async function checkedInStay(last: string, arrival = D0, departure = '2026-07-14') {
  const created = await gql(
    `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id rooms { id } } }`,
    {
      i: {
        guest: { firstName: 'Audit', lastName: last },
        source: 'DIRECT',
        arrivalDate: arrival,
        departureDate: departure,
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
  // Reset the trading day.
  await owner`UPDATE property.properties SET business_date = ${D0} WHERE id = ${ALPHA}`;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  owner = ownerClient();
  for (const who of ['admin', 'manager', 'frontdesk', 'auditor']) {
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

describe('posting room charges', () => {
  it('charges every in-house room for the night, with tax', async () => {
    const stay = await checkedInStay('Sharma');

    const res = await gql(RUN);
    expect(res.body.data.runNightAudit.status).toBe('COMPLETED');

    const folio = await gql(FOLIO, { id: stay.folioId }, tok['frontdesk']);
    const lines = folio.body.data.folio.lines;

    const roomCharge = lines.find((l: { code: string }) => l.code === 'ROOM');
    expect(roomCharge.amountMinor).toBe(350_000); // seeded STD rate
    expect(roomCharge.businessDate).toBe(D0); // the AUDIT date, not today

    const tax = lines.find((l: { type: string }) => l.type === 'TAX');
    expect(tax.amountMinor).toBe(42_000); // GST 12%

    expect(folio.body.data.folio.balanceMinor).toBe(392_000);
  });

  /**
   * THE DEPARTURE-NIGHT RULE. A guest leaving this morning is not charged for
   * tonight — the stay is half-open [arrival, departure). Charging it is the single
   * most common PMS billing complaint.
   */
  it('does NOT charge a guest who departs on the audit date', async () => {
    // Arrives D0-2, departs TODAY (the audit date). They are leaving this morning.
    const stay = await checkedInStay('Departing', '2026-07-09', D0);

    await gql(RUN);

    const folio = await gql(FOLIO, { id: stay.folioId }, tok['frontdesk']);
    const roomCharges = folio.body.data.folio.lines.filter(
      (l: { code: string }) => l.code === 'ROOM',
    );

    expect(
      roomCharges,
      'a departing guest was charged for the night they were not there',
    ).toHaveLength(0);
  });

  it('does not charge a guest who has not checked in', async () => {
    await gql(
      `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id } }`,
      {
        i: {
          guest: { firstName: 'Not', lastName: 'Arrived' },
          source: 'DIRECT',
          arrivalDate: '2026-07-20',
          departureDate: '2026-07-22',
          rooms: [{ roomTypeId: stdTypeId, ratePlanId: planId, adults: 1, children: 0 }],
        },
      },
      tok['frontdesk'],
    );

    const res = await gql(RUN);
    const step = res.body.data.runNightAudit.steps.find(
      (s: { step: string }) => s.step === 'POST_ROOM_CHARGES',
    );
    expect(step.detail).toMatch(/no in-house rooms/i);
  });

  /**
   * §8.2: "idempotency (re-running a step is a no-op)".
   */
  it('CANNOT charge the same night twice, even if the audit is re-run', async () => {
    const stay = await checkedInStay('Twice');

    await gql(RUN);

    const first = await gql(FOLIO, { id: stay.folioId }, tok['frontdesk']);
    const balanceAfterOne = first.body.data.folio.balanceMinor;
    expect(balanceAfterOne).toBe(392_000);

    // Force the property back to the audit date and run again — exactly what an
    // operator does after a failure.
    await owner`UPDATE property.properties SET business_date = ${D0} WHERE id = ${ALPHA}`;
    await owner`UPDATE shared.night_audit_runs SET status = 'FAILED' WHERE property_id = ${ALPHA}`;

    await gql(RUN);

    const second = await gql(FOLIO, { id: stay.folioId }, tok['frontdesk']);

    // The DB unique index makes the second insert a no-op. Without it the guest pays
    // for the night twice, and nobody notices until they read the bill.
    expect(
      second.body.data.folio.balanceMinor,
      'the guest was charged twice for the same night',
    ).toBe(balanceAfterOne);

    const roomCharges = second.body.data.folio.lines.filter(
      (l: { code: string }) => l.code === 'ROOM',
    );
    expect(roomCharges).toHaveLength(1);
  });

  /**
   * A night with no rate loaded cannot be charged. Posting an invented number onto
   * a guest's bill, or zero (a free room), are both worse than stopping.
   */
  it('FAILS the step, resumably, when a night has no rate loaded', async () => {
    const stay = await checkedInStay('Unpriced');

    await owner`
      DELETE FROM inventory.rate_prices
      WHERE property_id = ${ALPHA} AND room_type_id = ${stdTypeId} AND date = ${D0}
    `;

    try {
      const res = await gql(RUN);
      expect(res.body.errors[0].message).toMatch(/no rate is loaded/i);

      // Nothing was charged, and the trading day did NOT close.
      const folio = await gql(FOLIO, { id: stay.folioId }, tok['frontdesk']);
      expect(folio.body.data.folio.balanceMinor).toBe(0);

      const [p] = await owner`SELECT business_date FROM property.properties WHERE id = ${ALPHA}`;
      expect(p?.['business_date']).toBe(D0);

      const [run] = await owner`
        SELECT status FROM shared.night_audit_runs WHERE property_id = ${ALPHA}
      `;
      expect(run?.['status']).toBe('FAILED');

      // Price the night, then resume — it picks up from the failed step.
      await owner`
        INSERT INTO inventory.rate_prices (id, property_id, rate_plan_id, room_type_id, date, price_minor)
        VALUES (gen_random_uuid(), ${ALPHA}, ${planId}, ${stdTypeId}, ${D0}, 350000)
      `;

      const resumed = await gql(RUN);
      expect(resumed.body.data.runNightAudit.status).toBe('COMPLETED');

      const after = await gql(FOLIO, { id: stay.folioId }, tok['frontdesk']);
      expect(after.body.data.folio.balanceMinor).toBe(392_000);
    } finally {
      await owner`
        INSERT INTO inventory.rate_prices (id, property_id, rate_plan_id, room_type_id, date, price_minor)
        VALUES (gen_random_uuid(), ${ALPHA}, ${planId}, ${stdTypeId}, ${D0}, 350000)
        ON CONFLICT (rate_plan_id, room_type_id, date) DO NOTHING
      `;
    }
  });
});

describe('no-shows', () => {
  it('marks an unarrived confirmed booking NO_SHOW and RELEASES its inventory', async () => {
    const created = await gql(
      `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id } }`,
      {
        i: {
          guest: { firstName: 'Never', lastName: 'Came' },
          source: 'PHONE',
          arrivalDate: D0, // due today, never arrived
          departureDate: '2026-07-14',
          rooms: [{ roomTypeId: stdTypeId, ratePlanId: planId, adults: 1, children: 0 }],
        },
      },
      tok['frontdesk'],
    );
    const id = created.body.data.createReservation.id;

    const [soldBefore] = await owner`
      SELECT sold FROM reservations.room_type_availability
      WHERE property_id = ${ALPHA} AND room_type_id = ${stdTypeId} AND date = ${D0}
    `;
    expect(Number(soldBefore!['sold'])).toBe(1);

    await gql(RUN);

    const [after] = await owner`SELECT status FROM reservations.reservations WHERE id = ${id}`;
    expect(after?.['status']).toBe('NO_SHOW');

    // A no-show that keeps its room would quietly shrink the hotel by one room a
    // night, forever.
    const [soldAfter] = await owner`
      SELECT sold FROM reservations.room_type_availability
      WHERE property_id = ${ALPHA} AND room_type_id = ${stdTypeId} AND date = ${D0}
    `;
    expect(Number(soldAfter!['sold']), 'no-show inventory was never released').toBe(0);
  });

  it('does not touch a future booking', async () => {
    const created = await gql(
      `mutation($i: CreateReservationGqlInput!) { createReservation(input: $i) { id } }`,
      {
        i: {
          guest: { firstName: 'Next', lastName: 'Week' },
          source: 'DIRECT',
          arrivalDate: '2026-07-20',
          departureDate: '2026-07-22',
          rooms: [{ roomTypeId: stdTypeId, ratePlanId: planId, adults: 1, children: 0 }],
        },
      },
      tok['frontdesk'],
    );

    await gql(RUN);

    const [after] = await owner`
      SELECT status FROM reservations.reservations WHERE id = ${created.body.data.createReservation.id}
    `;
    expect(after?.['status']).toBe('CONFIRMED');
  });

  it('does not touch a guest who is already in-house', async () => {
    const stay = await checkedInStay('InHouse');
    await gql(RUN);

    const [after] = await owner`
      SELECT status FROM reservations.reservations WHERE id = ${stay.reservationId}
    `;
    expect(after?.['status']).toBe('CHECKED_IN');
  });
});

describe('the frozen snapshot', () => {
  it('records occupancy, ADR and RevPAR for the night', async () => {
    await checkedInStay('StatsA');
    await checkedInStay('StatsB');

    await gql(RUN);

    const res = await gql(STATS, { f: D0, t: D0 }, tok['auditor']);
    const s = res.body.data.occupancyReport[0];

    expect(s.businessDate).toBe(D0);
    expect(s.roomsSold).toBe(2);
    expect(s.roomRevenueMinor).toBe(700_000); // 2 × 3,500, NET of tax

    // ADR divides by rooms SOLD; RevPAR by rooms AVAILABLE. Confusing them is the
    // classic hotel-metrics error — ADR flatters a half-empty hotel.
    expect(s.adrMinor).toBe(350_000);
    expect(s.revparMinor).toBe(Math.round(700_000 / s.roomsAvailable));
    expect(s.revparMinor).toBeLessThan(s.adrMinor); // the hotel is not full

    expect(s.occupancyBps).toBe(Math.round((2 / s.roomsAvailable) * 10_000));
  });

  it('excludes out-of-order rooms from availability', async () => {
    const [ooo] = await owner`
      SELECT count(*)::int AS n FROM inventory.rooms
      WHERE property_id = ${ALPHA} AND status IN ('OOO','OOS')
    `;
    const [total] = await owner`
      SELECT count(*)::int AS n FROM inventory.rooms WHERE property_id = ${ALPHA}
    `;

    await gql(RUN);

    const res = await gql(STATS, { f: D0, t: D0 }, tok['auditor']);
    const s = res.body.data.occupancyReport[0];

    // A hotel does not get to claim credit for rooms it cannot sell.
    expect(s.roomsAvailable).toBe(Number(total!['n']) - Number(ooo!['n']));
    expect(s.roomsOutOfOrder ?? Number(ooo!['n'])).toBeDefined();
  });

  it('reports zero ADR on an empty night rather than dividing by zero', async () => {
    await gql(RUN);

    const res = await gql(STATS, { f: D0, t: D0 }, tok['auditor']);
    const s = res.body.data.occupancyReport[0];

    expect(s.roomsSold).toBe(0);
    expect(s.adrMinor).toBe(0);
    expect(s.occupancyBps).toBe(0);
  });

  it('re-running the audit overwrites the snapshot rather than duplicating it', async () => {
    await checkedInStay('Snap');
    await gql(RUN);

    await owner`UPDATE property.properties SET business_date = ${D0} WHERE id = ${ALPHA}`;
    await owner`UPDATE shared.night_audit_runs SET status = 'FAILED' WHERE property_id = ${ALPHA}`;
    await gql(RUN);

    const rows = await owner`
      SELECT count(*)::int AS n FROM reporting.daily_stats
      WHERE property_id = ${ALPHA} AND business_date = ${D0}
    `;
    // Two contradictory snapshots for the same night is worse than none.
    expect(Number(rows[0]!['n'])).toBe(1);
  });
});

describe('advancing the business date', () => {
  it('moves the trading day forward by exactly one', async () => {
    const res = await gql(RUN);

    expect(res.body.data.runNightAudit.businessDate).toBe(D0);
    expect(res.body.data.runNightAudit.newBusinessDate).toBe(D1);

    const [p] = await owner`SELECT business_date FROM property.properties WHERE id = ${ALPHA}`;
    expect(p?.['business_date']).toBe(D1);
  });

  it('refuses to run the same night twice', async () => {
    await gql(RUN);

    // The date has moved on. Running again would audit the NEXT night, which has not
    // happened yet.
    const [run] = await owner`
      SELECT status FROM shared.night_audit_runs WHERE property_id = ${ALPHA} AND business_date = ${D0}
    `;
    expect(run?.['status']).toBe('COMPLETED');

    await owner`UPDATE property.properties SET business_date = ${D0} WHERE id = ${ALPHA}`;

    const again = await gql(RUN);
    expect(again.body.errors[0].message).toMatch(/already completed/i);
  });

  it('charges post to the NEW business date after the audit', async () => {
    const stay = await checkedInStay('Tomorrow');
    await gql(RUN);

    await gql(
      `mutation($i: PostChargeGqlInput!) { postCharge(input: $i) { balance } }`,
      {
        i: {
          folioId: stay.folioId,
          code: 'F&B',
          description: 'Breakfast',
          amountMinor: 30_000,
          quantity: 1,
          currency: 'INR',
        },
      },
      tok['frontdesk'],
    );

    const folio = await gql(FOLIO, { id: stay.folioId }, tok['frontdesk']);
    const breakfast = folio.body.data.folio.lines.find(
      (l: { code: string }) => l.code === 'F&B',
    );

    // The trading day rolled over; today's charges belong to today.
    expect(breakfast.businessDate).toBe(D1);
  });
});

describe('the run record', () => {
  it('records every step', async () => {
    const res = await gql(RUN);
    const steps = res.body.data.runNightAudit.steps;

    expect(steps.map((s: { step: string }) => s.step)).toEqual([
      'POST_ROOM_CHARGES',
      'MARK_NO_SHOWS',
      'SNAPSHOT_STATS',
      'ADVANCE_BUSINESS_DATE',
    ]);
    expect(steps.every((s: { status: string }) => s.status === 'COMPLETED')).toBe(true);
  });

  it('emits night_audit.completed', async () => {
    await gql(RUN);

    const events = await owner`
      SELECT event_type FROM shared.outbox_events
      WHERE event_type = 'night_audit.completed' AND aggregate_id = ${ALPHA}
    `;
    expect(events.length).toBeGreaterThan(0);
  });
});

describe('RBAC', () => {
  it('refuses front desk closing the books', async () => {
    const res = await gql(RUN, undefined, tok['frontdesk']);
    expect(res.body.errors[0].message).toMatch(/insufficient permissions/i);
  });

  it('refuses the auditor RUNNING it, but lets them READ the numbers', async () => {
    const run = await gql(RUN, undefined, tok['auditor']);
    expect(run.body.errors[0].message).toMatch(/insufficient permissions/i);

    const read = await gql(STATS, { f: D0, t: D1 }, tok['auditor']);
    expect(read.body.errors).toBeFalsy();
  });
});
