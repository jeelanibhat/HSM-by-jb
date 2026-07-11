/**
 * The transactional guarantees of the shared kernel (TDD §2, §6, §8.1).
 *
 * These are the properties the whole audit and event story rests on:
 *
 *   - a committed mutation ALWAYS has its audit row and its events
 *   - a rolled-back mutation has NEITHER — no event for a reservation that was
 *     never created, no silent mutation with no audit trail
 *   - the relay delivers at-least-once and never loses an event
 *   - concurrent relays (i.e. multiple API replicas) never double-publish
 *
 * They can only be tested against a real Postgres: the guarantee IS the
 * transaction. An in-memory fake would assert nothing.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { AppModule } from '../../app.module';
import { cleanupProperties, ownerClient } from '../../test/db';
import { EventBus } from '../events/event-bus';
import { OutboxRelay } from '../outbox/outbox.relay';
import { TransactionalUnitOfWork } from '../unit-of-work';
import type { PublishedEvent } from '../events/domain-event';

const ORG = 'eeeeeeee-0000-0000-0000-00000000000f';
const PROPERTY = 'eeeeeeee-1111-1111-1111-111111111111';
const OTHER_PROPERTY = 'eeeeeeee-2222-2222-2222-222222222222';
const USER = 'eeeeeeee-3333-3333-3333-333333333333';

let app: INestApplication;
let uow: TransactionalUnitOfWork;
let relay: OutboxRelay;
let bus: EventBus;
let owner: postgres.Sql;

const actor = { propertyId: PROPERTY, userId: USER };

/** A convenient real domain write: a tax row on our fixture property. */
async function insertTax(tx: { execute: (q: never) => Promise<unknown> }, id: string, name: string) {
  const { sql } = await import('drizzle-orm');
  await tx.execute(sql`
    INSERT INTO property.taxes (id, property_id, name, rate_bps, type)
    VALUES (${id}, ${PROPERTY}, ${name}, 1200, 'EXCLUSIVE')
  ` as never);
}

async function auditRows() {
  return owner`SELECT * FROM shared.audit_log WHERE property_id = ${PROPERTY} ORDER BY at`;
}
async function outboxRows() {
  return owner`
    SELECT * FROM shared.outbox_events
    WHERE payload->>'propertyId' = ${PROPERTY}
    ORDER BY created_at
  `;
}
async function taxRows() {
  return owner`SELECT * FROM property.taxes WHERE property_id = ${PROPERTY}`;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  uow = app.get(TransactionalUnitOfWork);
  relay = app.get(OutboxRelay);
  bus = app.get(EventBus);
  owner = ownerClient();
}, 60_000);

afterAll(async () => {
  await cleanupProperties(owner, [PROPERTY, OTHER_PROPERTY], ORG);
  await owner.end();
  await app?.close();
});

beforeEach(async () => {
  await cleanupProperties(owner, [PROPERTY, OTHER_PROPERTY], ORG);
  await owner`DELETE FROM shared.outbox_events WHERE payload->>'propertyId' IN (${PROPERTY}, ${OTHER_PROPERTY})`;

  await owner`INSERT INTO property.organizations (id, name) VALUES (${ORG}, 'UoW Fixture Group')`;
  await owner`
    INSERT INTO property.properties (id, organization_id, name, timezone, currency, business_date)
    VALUES
      (${PROPERTY},       ${ORG}, 'UoW Fixture Hotel', 'Asia/Kolkata', 'INR', '2026-07-11'),
      (${OTHER_PROPERTY}, ${ORG}, 'UoW Other Hotel',   'Asia/Kolkata', 'INR', '2026-07-11')
  `;
});

afterEach(async () => {
  await owner`DELETE FROM shared.outbox_events WHERE payload->>'propertyId' IN (${PROPERTY}, ${OTHER_PROPERTY})`;
});

describe('commit: the mutation, its audit row and its events land together', () => {
  it('writes the domain row, the audit entry and the outbox event in one transaction', async () => {
    const taxId = uuidv7();

    await uow.execute(actor, async (u) => {
      await insertTax(u.tx as never, taxId, 'GST 12%');

      u.audit({
        action: 'tax.created',
        entityType: 'tax',
        entityId: taxId,
        after: { name: 'GST 12%', rateBps: 1200 },
      });

      u.emit({
        aggregateType: 'tax',
        aggregateId: taxId,
        eventType: 'room.status_changed', // any catalogued type; payload is what matters here
        payload: { taxId },
      });
    });

    expect(await taxRows()).toHaveLength(1);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.['action']).toBe('tax.created');
    expect(audits[0]?.['user_id']).toBe(USER);
    expect(audits[0]?.['after']).toMatchObject({ name: 'GST 12%', rateBps: 1200 });

    const events = await outboxRows();
    expect(events).toHaveLength(1);
    expect(events[0]?.['processed_at']).toBeNull(); // relay has not run yet
  });

  it('stamps every event with the property and the actor', async () => {
    await uow.execute(actor, async (u) => {
      u.emit({
        aggregateType: 'room',
        aggregateId: uuidv7(),
        eventType: 'room.status_changed',
        payload: { status: 'VACANT_DIRTY' },
      });
    });

    const [event] = await outboxRows();
    const payload = event?.['payload'] as Record<string, unknown>;

    // A consumer must be able to tell WHICH hotel an event belongs to without a
    // join — otherwise the reporting projection has no tenant to attribute it to.
    expect(payload['propertyId']).toBe(PROPERTY);
    expect(payload['userId']).toBe(USER);
    expect(payload['status']).toBe('VACANT_DIRTY');
  });

  it('records several audits and events from one use-case', async () => {
    await uow.execute(actor, async (u) => {
      for (let i = 0; i < 3; i++) {
        const id = uuidv7();
        await insertTax(u.tx as never, id, `Tax ${i}`);
        u.audit({ action: 'tax.created', entityType: 'tax', entityId: id });
        u.emit({
          aggregateType: 'tax',
          aggregateId: id,
          eventType: 'room.status_changed',
          payload: { i },
        });
      }
    });

    expect(await taxRows()).toHaveLength(3);
    expect(await auditRows()).toHaveLength(3);
    expect(await outboxRows()).toHaveLength(3);
  });
});

/**
 * THE guarantee. Anything else can be worked around; this cannot.
 */
describe('rollback: nothing survives a failed mutation', () => {
  it('leaves NO domain row, NO audit row and NO event when the use-case throws', async () => {
    const taxId = uuidv7();

    await expect(
      uow.execute(actor, async (u) => {
        await insertTax(u.tx as never, taxId, 'Doomed');

        u.audit({ action: 'tax.created', entityType: 'tax', entityId: taxId });
        u.emit({
          aggregateType: 'tax',
          aggregateId: taxId,
          eventType: 'room.status_changed',
          payload: {},
        });

        // Business rule violated after the writes — exactly the shape of a real
        // failure (availability check fails after the row is staged).
        throw new Error('business rule violated');
      }),
    ).rejects.toThrow('business rule violated');

    expect(await taxRows(), 'domain row survived a rollback').toHaveLength(0);
    expect(await auditRows(), 'audit row survived a rollback').toHaveLength(0);

    // The one that really matters: an event for something that never happened
    // would tell housekeeping to clean a room for a reservation that does not exist.
    expect(await outboxRows(), 'PHANTOM EVENT: emitted for a rolled-back change').toHaveLength(0);
  });

  it('rolls back the audit when the DB rejects the write (RLS, constraint)', async () => {
    await expect(
      uow.execute(actor, async (u) => {
        u.audit({ action: 'tax.created', entityType: 'tax', entityId: uuidv7() });

        // Cross-tenant insert — RLS rejects it. The audit row must go with it.
        const { sql } = await import('drizzle-orm');
        await u.tx.execute(sql`
          INSERT INTO property.taxes (id, property_id, name, rate_bps, type)
          VALUES (${uuidv7()}, ${OTHER_PROPERTY}, 'Smuggled', 1200, 'EXCLUSIVE')
        `);
      }),
    ).rejects.toThrow();

    expect(await auditRows()).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe('outbox relay', () => {
  it('publishes pending events and marks them processed', async () => {
    const seen: PublishedEvent[] = [];
    bus.on('room.status_changed', (e) => void seen.push(e));

    const aggregateId = uuidv7();
    await uow.execute(actor, async (u) => {
      u.emit({
        aggregateType: 'room',
        aggregateId,
        eventType: 'room.status_changed',
        payload: { status: 'OCCUPIED' },
      });
    });

    expect(await relay.pendingCount()).toBeGreaterThan(0);

    const published = await relay.drain();
    expect(published).toBeGreaterThan(0);

    const mine = seen.find((e) => e.aggregateId === aggregateId);
    expect(mine, 'handler never saw the event').toBeTruthy();
    expect(mine?.propertyId).toBe(PROPERTY);
    expect(mine?.payload['status']).toBe('OCCUPIED');

    const rows = await outboxRows();
    expect(rows[0]?.['processed_at'], 'event was not marked processed').not.toBeNull();
  });

  it('does not republish an already-processed event', async () => {
    let deliveries = 0;
    bus.on('night_audit.completed', () => void (deliveries += 1));

    await uow.execute(actor, async (u) => {
      u.emit({
        aggregateType: 'property',
        aggregateId: PROPERTY,
        eventType: 'night_audit.completed',
        payload: {},
      });
    });

    await relay.drain();
    const afterFirst = deliveries;

    await relay.drain();
    await relay.drain();

    expect(deliveries, 'a processed event was redelivered').toBe(afterFirst);
  });

  it('is a no-op when the queue is empty', async () => {
    await relay.drain();
    expect(await relay.drain()).toBe(0);
  });

  /**
   * At-least-once. A handler that throws must NOT let the event be marked
   * processed — losing a `reservation.checked_in` would leave housekeeping
   * permanently unaware the room is occupied. Redelivery is the lesser evil.
   */
  it('leaves an event unprocessed when a handler fails, and retries it', async () => {
    let attempts = 0;

    bus.on('folio.line_posted', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('handler exploded');
    });

    await uow.execute(actor, async (u) => {
      u.emit({
        aggregateType: 'folio',
        aggregateId: uuidv7(),
        eventType: 'folio.line_posted',
        payload: {},
      });
    });

    await relay.drain();

    expect(attempts).toBe(1);
    const afterFailure = await outboxRows();
    expect(
      afterFailure[0]?.['processed_at'],
      'event marked processed despite a failing handler — it would be lost',
    ).toBeNull();

    // Next tick redelivers it; this time the handler succeeds.
    await relay.drain();

    expect(attempts).toBe(2);
    const afterRetry = await outboxRows();
    expect(afterRetry[0]?.['processed_at']).not.toBeNull();
  });

  /**
   * Multiple API replicas each run a relay. FOR UPDATE SKIP LOCKED is what stops
   * them publishing the same event twice.
   */
  it('does not double-publish when two relays drain concurrently', async () => {
    const delivered: string[] = [];
    bus.on('reservation.created', (e) => void delivered.push(e.id));

    await uow.execute(actor, async (u) => {
      for (let i = 0; i < 20; i++) {
        u.emit({
          aggregateType: 'reservation',
          aggregateId: uuidv7(),
          eventType: 'reservation.created',
          payload: { i },
        });
      }
    });

    // Two relays racing, as two API pods would.
    await Promise.all([relay.drain(5), relay.drain(5)]);

    // Drain any stragglers a SKIP_LOCKED peer left behind.
    await relay.drain();

    expect(delivered).toHaveLength(20);
    expect(new Set(delivered).size, 'an event was published more than once').toBe(20);

    // Scoped to THIS suite's events, not relay.pendingCount(), which is global.
    // A global assertion here couples this test to every other suite's outbox
    // traffic — it fails the moment anything else leaves an event pending, which
    // says nothing about whether the relay double-published.
    const stillPending = await owner`
      SELECT count(*)::int AS n FROM shared.outbox_events
      WHERE payload->>'propertyId' = ${PROPERTY} AND processed_at IS NULL
    `;
    expect(stillPending[0]?.['n']).toBe(0);
  });
});
