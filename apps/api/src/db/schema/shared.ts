/**
 * Shared-kernel tables (TDD §4.5): outbox, audit log, night-audit runs.
 * These are cross-cutting infrastructure, not owned by any domain module.
 */
import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
  date,
  varchar,
} from 'drizzle-orm/pg-core';

export const sharedSchema = pgSchema('shared');

/**
 * Transactional outbox (TDD §2, principle 3). Events are written in the SAME
 * transaction as the state change that produced them, then relayed
 * asynchronously. This is what makes "check-in emits reservation.checked_in"
 * atomic — no dual-write, no lost events if the bus is down.
 */
export const outboxEvents = sharedSchema.table(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    aggregateType: varchar('aggregate_type', { length: 64 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: varchar('event_type', { length: 128 }).notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    // The relay's hot path: find unprocessed events oldest-first. Partial index
    // keeps it tiny — processed rows fall out of the index entirely.
    index('outbox_unprocessed_idx')
      .on(t.createdAt)
      .where(sql`${t.processedAt} IS NULL`),
  ],
);

/**
 * Append-only audit log (TDD §2, principle 4). Every mutation writes here in the
 * same transaction. Never UPDATE, never DELETE — financial compliance depends on it.
 */
export const auditLog = sharedSchema.table(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id').notNull(),
    userId: uuid('user_id'),
    action: varchar('action', { length: 128 }).notNull(),
    entityType: varchar('entity_type', { length: 64 }).notNull(),
    entityId: uuid('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason'), // destructive ops carry one (TDD §7.4)
    at: timestamp('at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('audit_entity_idx').on(t.propertyId, t.entityType, t.entityId),
    index('audit_at_idx').on(t.propertyId, t.at),
  ],
);

/**
 * Night-audit runs (TDD §6). `steps` records each step's outcome so a failed run
 * is resumable rather than restart-from-scratch.
 */
export const nightAuditRuns = sharedSchema.table(
  'night_audit_runs',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id').notNull(),
    businessDate: date('business_date').notNull(),
    status: varchar('status', { length: 16 }).notNull(), // RUNNING | COMPLETED | FAILED
    steps: jsonb('steps').notNull().default(sql`'[]'::jsonb`),
    startedBy: uuid('started_by'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    // One audit per property per business date — the idempotency guarantee.
    index('night_audit_property_date_idx').on(t.propertyId, t.businessDate),
  ],
);
