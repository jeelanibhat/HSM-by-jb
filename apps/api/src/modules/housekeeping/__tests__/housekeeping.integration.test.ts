/**
 * Housekeeping (Phase 2): the day's board, the work, and the inspection.
 *
 * Runs against the real API — real guards, real RLS, real transactions.
 * Assumes `pnpm db:migrate && pnpm db:seed`.
 *
 * The authorization tests are here from the FIRST commit, deliberately. At the end of
 * Phase 1, 179 integration tests missed a real hole (housekeeping could read any
 * guest's folio) because every one of them authenticated as a role that was ALLOWED.
 * No test ever asked a forbidden question, so nothing ever failed.
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
const userIds: Record<string, string> = {};

function gql(
  query: string,
  variables?: unknown,
  opts: { token?: string; propertyId?: string } = {},
) {
  const req = request(app.getHttpServer()).post('/graphql');
  if (opts.token) req.set('Authorization', `Bearer ${opts.token}`);
  if (opts.propertyId) req.set('X-Property-Id', opts.propertyId);
  return req.send({ query, variables });
}

/** As a given role, at Alpha. */
function as(who: string, query: string, variables?: unknown) {
  return gql(query, variables, { token: tokens[who]!, propertyId: ALPHA });
}

async function login(email: string): Promise<string> {
  const res = await gql(`mutation($i: LoginInput!) { login(input: $i) { accessToken } }`, {
    i: { email, password: PASSWORD },
  });
  return res.body.data.login.accessToken;
}

const BOARD = `
  query($date: String) {
    housekeepingBoard(date: $date) {
      id roomId roomNumber roomStatus type status assignedTo assigneeName
      credits failedInspections inspectionNote
    }
  }
`;

const GENERATE = `
  mutation($i: GenerateHousekeepingBoardGqlInput) {
    generateHousekeepingBoard(input: $i) { created businessDate }
  }
`;

const CREATE = `
  mutation($i: CreateHousekeepingTaskGqlInput!) {
    createHousekeepingTask(input: $i) { id status type credits }
  }
`;

const ASSIGN = `
  mutation($i: AssignHousekeepingTaskGqlInput!) {
    assignHousekeepingTask(input: $i) { id assignedTo assigneeName }
  }
`;

const START = `
  mutation($i: StartHousekeepingTaskGqlInput!) {
    startHousekeepingTask(input: $i) { id status assignedTo }
  }
`;

const COMPLETE = `
  mutation($i: CompleteHousekeepingTaskGqlInput!) {
    completeHousekeepingTask(input: $i) { id status }
  }
`;

const INSPECT = `
  mutation($i: InspectHousekeepingTaskGqlInput!) {
    inspectHousekeepingTask(input: $i) { id status failedInspections inspectionNote }
  }
`;

const BUSINESS_DATE = '2026-07-11';

/** A room, forced into the status the test needs. Never depend on incidental seed state. */
async function roomInStatus(status: string) {
  const [row] = await owner`
    SELECT id, number FROM inventory.rooms
    WHERE property_id = ${ALPHA}
      AND id NOT IN (
        SELECT room_id FROM reservations.reservation_rooms
        WHERE room_id IS NOT NULL AND status NOT IN ('CANCELLED','NO_SHOW')
      )
    ORDER BY number
    LIMIT 1
  `;

  await owner`UPDATE inventory.rooms SET status = ${status} WHERE id = ${row!['id']}`;
  return { id: row!['id'] as string, number: row!['number'] as string };
}

async function roomStatus(roomId: string): Promise<string> {
  const [row] = await owner`SELECT status FROM inventory.rooms WHERE id = ${roomId}`;
  return row!['status'] as string;
}

/** A PENDING task on a freshly-dirtied room. */
async function pendingTask(type = 'DEPARTURE') {
  const room = await roomInStatus('VACANT_DIRTY');

  const res = await as('manager', CREATE, {
    i: { roomId: room.id, type, businessDate: BUSINESS_DATE },
  });

  return { room, taskId: res.body.data.createHousekeepingTask.id as string };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.use(cookieParser());
  await app.init();

  owner = ownerClient();

  for (const who of ['admin', 'manager', 'frontdesk', 'housekeeping', 'auditor', 'beta.frontdesk']) {
    tokens[who] = await login(`${who}@hotelos.dev`);

    const [row] = await owner`SELECT id FROM identity.users WHERE email = ${`${who}@hotelos.dev`}`;
    userIds[who] = row!['id'] as string;
  }

  await owner`UPDATE property.properties SET business_date = ${BUSINESS_DATE} WHERE id = ${ALPHA}`;
}, 90_000);

afterAll(async () => {
  await owner?.end();
  await app?.close();
});

beforeEach(async () => {
  await owner`DELETE FROM housekeeping.tasks`;
});

// ── The board ────────────────────────────────────────────────────────────────

describe('generating the day’s board', () => {
  it('raises a DEPARTURE clean for every room the guest has already left', async () => {
    const room = await roomInStatus('VACANT_DIRTY');

    const res = await as('manager', GENERATE, { i: { businessDate: BUSINESS_DATE } });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.generateHousekeepingBoard.created).toBeGreaterThan(0);

    const board = await as('manager', BOARD, { date: BUSINESS_DATE });
    const task = board.body.data.housekeepingBoard.find((t: any) => t.roomId === room.id);

    expect(task, 'a vacated room got no clean').toBeTruthy();
    expect(task.type).toBe('DEPARTURE');
    expect(task.status).toBe('PENDING');
  });

  it('is IDEMPOTENT — a supervisor hitting generate twice does not double the morning', async () => {
    await roomInStatus('VACANT_DIRTY');

    const first = await as('manager', GENERATE, { i: { businessDate: BUSINESS_DATE } });
    const created = first.body.data.generateHousekeepingBoard.created;
    expect(created).toBeGreaterThan(0);

    const second = await as('manager', GENERATE, { i: { businessDate: BUSINESS_DATE } });

    // Not "created them again" and not "created some of them again". Nothing.
    expect(
      second.body.data.generateHousekeepingBoard.created,
      'the second run duplicated the board',
    ).toBe(0);

    const [row] = await owner`
      SELECT count(*)::int AS n FROM housekeeping.tasks WHERE business_date = ${BUSINESS_DATE}
    `;
    expect(Number(row!['n'])).toBe(created);
  });

  it('does not reset the progress of work already underway', async () => {
    // The 11am case: half the board is cleaned, someone hits generate again.
    const { room, taskId } = await pendingTask();
    await as('housekeeping', START, { i: { taskId } });

    await as('manager', GENERATE, { i: { businessDate: BUSINESS_DATE } });

    const [task] = await owner`SELECT status FROM housekeeping.tasks WHERE id = ${taskId}`;
    expect(task!['status'], 'generate wiped work in progress').toBe('IN_PROGRESS');
    expect(room).toBeTruthy();
  });
});

// ── Working a task ───────────────────────────────────────────────────────────

describe('working a task', () => {
  it('turns the room over: a completed DEPARTURE clean makes it sellable', async () => {
    const { room, taskId } = await pendingTask();
    expect(await roomStatus(room.id)).toBe('VACANT_DIRTY');

    await as('housekeeping', START, { i: { taskId } });
    const done = await as('housekeeping', COMPLETE, { i: { taskId } });

    expect(done.body.errors).toBeUndefined();
    expect(done.body.data.completeHousekeepingTask.status).toBe('DONE');

    // The room and the task cannot disagree — same transaction.
    expect(await roomStatus(room.id), 'the cleaned room is still dirty').toBe('VACANT_CLEAN');
  });

  it('claims an unassigned task for whoever picks it up', async () => {
    const { taskId } = await pendingTask();

    const res = await as('housekeeping', START, { i: { taskId } });
    expect(res.body.data.startHousekeepingTask.assignedTo).toBe(userIds['housekeeping']);
  });

  it('NEVER frees an occupied room — a stayover clean leaves the guest in it', async () => {
    // The guest is asleep in there. Marking the room VACANT_CLEAN would put it back
    // into inventory and sell it out from under them.
    const room = await roomInStatus('OCCUPIED');

    const created = await as('manager', CREATE, {
      i: { roomId: room.id, type: 'STAYOVER', businessDate: BUSINESS_DATE },
    });
    const taskId = created.body.data.createHousekeepingTask.id;

    const done = await as('housekeeping', COMPLETE, { i: { taskId } });
    expect(done.body.errors).toBeUndefined();
    expect(done.body.data.completeHousekeepingTask.status).toBe('DONE');

    expect(await roomStatus(room.id), 'a stayover clean freed an occupied room').toBe('OCCUPIED');
  });

  it('refuses to reopen a task that was signed off', async () => {
    const { taskId } = await pendingTask();

    await as('housekeeping', COMPLETE, { i: { taskId } });
    await as('manager', INSPECT, { i: { taskId, passed: true } });

    const res = await as('housekeeping', START, { i: { taskId } });
    expect(res.body.errors?.[0]?.message).toMatch(/signed off/i);
  });
});

// ── Inspection: the reason this module exists ────────────────────────────────

describe('inspection', () => {
  it('signs the room off when it passes', async () => {
    const { room, taskId } = await pendingTask();
    await as('housekeeping', COMPLETE, { i: { taskId } });

    const res = await as('manager', INSPECT, { i: { taskId, passed: true } });

    expect(res.body.data.inspectHousekeepingTask.status).toBe('INSPECTED');
    expect(await roomStatus(room.id)).toBe('VACANT_CLEAN');

    // "Who said this room was fit to sell?" The row must answer.
    const [t] = await owner`SELECT inspected_by, inspected_at FROM housekeeping.tasks WHERE id = ${taskId}`;
    expect(t!['inspected_by']).toBe(userIds['manager']);
    expect(t!['inspected_at']).toBeTruthy();
  });

  it('sends the room BACK TO DIRTY when it fails, and reopens the task', async () => {
    // THE test. A supervisor judged the room unfit. If the system records that
    // judgement and then leaves the room marked clean, the next guest is handed a
    // room a supervisor personally said was not fit to sell.
    const { room, taskId } = await pendingTask();

    await as('housekeeping', COMPLETE, { i: { taskId } });
    expect(await roomStatus(room.id)).toBe('VACANT_CLEAN');

    const res = await as('manager', INSPECT, {
      i: { taskId, passed: false, reason: 'Bathroom not touched' },
    });

    expect(res.body.errors).toBeUndefined();

    const task = res.body.data.inspectHousekeepingTask;
    expect(task.status, 'a failed inspection did not reopen the task').toBe('PENDING');
    expect(task.failedInspections).toBe(1);
    expect(task.inspectionNote).toBe('Bathroom not touched');

    expect(
      await roomStatus(room.id),
      'a room that FAILED inspection is still marked clean — it will be sold',
    ).toBe('VACANT_DIRTY');
  });

  it('clears the timestamps so the reopened task looks like work to do, not work done', async () => {
    const { taskId } = await pendingTask();
    await as('housekeeping', COMPLETE, { i: { taskId } });
    await as('manager', INSPECT, { i: { taskId, passed: false, reason: 'Hair in the sink' } });

    const [t] = await owner`
      SELECT status, started_at, completed_at FROM housekeeping.tasks WHERE id = ${taskId}
    `;

    expect(t!['status']).toBe('PENDING');
    expect(t!['completed_at'], 'a reopened task still claims it was completed').toBeNull();
    expect(t!['started_at']).toBeNull();
  });

  it('can be cleaned again and passed the second time', async () => {
    const { room, taskId } = await pendingTask();

    await as('housekeeping', COMPLETE, { i: { taskId } });
    await as('manager', INSPECT, { i: { taskId, passed: false, reason: 'Bin not emptied' } });

    // Round two.
    await as('housekeeping', COMPLETE, { i: { taskId } });
    const res = await as('manager', INSPECT, { i: { taskId, passed: true } });

    expect(res.body.data.inspectHousekeepingTask.status).toBe('INSPECTED');
    expect(res.body.data.inspectHousekeepingTask.failedInspections).toBe(1); // history kept
    expect(await roomStatus(room.id)).toBe('VACANT_CLEAN');
  });

  it('refuses to inspect a task nobody has finished', async () => {
    const { taskId } = await pendingTask();

    const res = await as('manager', INSPECT, { i: { taskId, passed: true } });
    expect(res.body.errors?.[0]?.message).toMatch(/PENDING → INSPECTED|Illegal/i);
  });
});

// ── Authorization. The forbidden questions. ──────────────────────────────────

describe('RBAC — who may do what', () => {
  it('refuses to let the FRONT DESK inspect a room', async () => {
    // They have every incentive to pass a room they are about to sell.
    const { taskId } = await pendingTask();
    await as('housekeeping', COMPLETE, { i: { taskId } });

    const res = await as('frontdesk', INSPECT, { i: { taskId, passed: true } });

    expect(res.body.errors?.[0]?.message).toMatch(/permission|forbidden/i);
    expect(res.body.data?.inspectHousekeepingTask ?? null).toBeNull();

    const [t] = await owner`SELECT status FROM housekeeping.tasks WHERE id = ${taskId}`;
    expect(t!['status'], 'the front desk signed off a room').toBe('DONE');
  });

  it('refuses to let HOUSEKEEPING inspect their own work', async () => {
    // An attendant who can inspect their own room has not been inspected.
    const { taskId } = await pendingTask();
    await as('housekeeping', COMPLETE, { i: { taskId } });

    const res = await as('housekeeping', INSPECT, { i: { taskId, passed: true } });
    expect(res.body.errors?.[0]?.message).toMatch(/permission|forbidden/i);
  });

  it('refuses to let HOUSEKEEPING assign work to other people', async () => {
    const { taskId } = await pendingTask();

    const res = await as('housekeeping', ASSIGN, {
      i: { taskId, assignedTo: userIds['housekeeping'] },
    });
    expect(res.body.errors?.[0]?.message).toMatch(/permission|forbidden/i);
  });

  it("refuses to let one attendant close another attendant's room", async () => {
    // Otherwise the board can be made to look finished by someone who cleaned nothing.
    const { taskId } = await pendingTask();

    // The supervisor gives it to the admin user (standing in for a second attendant).
    await as('manager', ASSIGN, { i: { taskId, assignedTo: userIds['admin'] } });

    const res = await as('housekeeping', COMPLETE, { i: { taskId } });

    expect(res.body.errors?.[0]?.message).toMatch(/assigned to someone else/i);

    const [t] = await owner`SELECT status FROM housekeeping.tasks WHERE id = ${taskId}`;
    expect(t!['status']).toBe('PENDING');
  });

  it('lets a SUPERVISOR work anyone’s task — somebody has to cover a sick call', async () => {
    const { taskId } = await pendingTask();
    await as('manager', ASSIGN, { i: { taskId, assignedTo: userIds['housekeeping'] } });

    const res = await as('manager', COMPLETE, { i: { taskId } });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.completeHousekeepingTask.status).toBe('DONE');
  });

  it('refuses to let the AUDITOR change anything — they read, they do not touch', async () => {
    const { taskId } = await pendingTask();

    for (const [name, mutation, vars] of [
      ['complete', COMPLETE, { i: { taskId } }],
      ['generate', GENERATE, { i: { businessDate: BUSINESS_DATE } }],
      ['inspect', INSPECT, { i: { taskId, passed: true } }],
    ] as const) {
      const res = await as('auditor', mutation, vars);
      expect(res.body.errors?.[0]?.message, `the auditor could ${name}`).toMatch(
        /permission|forbidden/i,
      );
    }
  });

  it('lets the front desk READ the board — they need to know which rooms are ready', async () => {
    await pendingTask();

    const res = await as('frontdesk', BOARD, { date: BUSINESS_DATE });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.housekeepingBoard.length).toBeGreaterThan(0);
  });
});

// ── Tenancy ──────────────────────────────────────────────────────────────────

describe('tenancy', () => {
  it("never shows one hotel's board to another", async () => {
    await pendingTask();

    // Beta's front desk, asking Beta. RLS scopes it; there is nothing to see.
    const res = await gql(BOARD, { date: BUSINESS_DATE }, {
      token: tokens['beta.frontdesk']!,
      propertyId: BETA,
    });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.housekeepingBoard).toEqual([]);
  });

  it("refuses a Beta user asking for Alpha's board at all", async () => {
    const res = await gql(BOARD, { date: BUSINESS_DATE }, {
      token: tokens['beta.frontdesk']!,
      propertyId: ALPHA,
    });

    expect(res.body.errors?.[0]?.message).toMatch(/access|permission|forbidden/i);
  });
});
