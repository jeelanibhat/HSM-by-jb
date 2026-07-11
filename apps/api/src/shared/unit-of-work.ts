import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DB, type Database } from '../db/db.tokens';
import type { TenantTx } from '../db/tenant-transaction';
import { auditLog, outboxEvents } from '../db/schema/shared';
import type { DomainEvent } from './events/domain-event';

/**
 * Who is doing this, and to which hotel. Every mutation has both.
 */
export interface ActorContext {
  propertyId: string;
  userId: string;
}

export interface AuditEntry {
  action: string; // 'reservation.created', 'folio.line_voided', ...
  entityType: string; // 'reservation', 'folio_line', ...
  entityId: string;
  before?: unknown;
  after?: unknown;
  /** Required for destructive ops — void, cancel (TDD §7.4). Feeds the audit log. */
  reason?: string;
}

/**
 * The handle a use-case gets. It cannot reach the database except through `tx`,
 * and anything it records here lands in the same commit.
 */
export interface UnitOfWork {
  readonly tx: TenantTx;
  readonly propertyId: string;
  readonly userId: string;

  /** Record a mutation in the append-only audit log (TDD §2, principle 4). */
  audit(entry: AuditEntry): void;

  /** Emit a domain event via the transactional outbox (TDD §2, principle 3). */
  emit(event: DomainEvent): void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Transactional unit of work — the enforcement point for two invariants that are
 * otherwise pure convention:
 *
 *   "All mutations write audit_log entries in the same transaction."   (§6)
 *   "Modules communicate via a transactional outbox."                  (§2)
 *
 * Both are satisfied BY CONSTRUCTION here. A use-case calls `uow.audit(...)` and
 * `uow.emit(...)`; the rows are flushed inside the same transaction, just before
 * commit. If the business logic throws, the transaction rolls back and the audit
 * row and the event vanish with it — you cannot end up with an event for a
 * reservation that was never created, or a committed change with no audit trail.
 *
 * This is why an @Injectable() AuditInterceptor would have been the wrong shape:
 * an interceptor runs AROUND the resolver, so by the time it fires the domain
 * transaction has already committed. It could only ever write the audit row in a
 * SECOND transaction — which can fail independently, leaving a mutation with no
 * audit entry. For a system whose financial compliance rests on that log, a
 * best-effort audit is not an audit.
 */
@Injectable()
export class TransactionalUnitOfWork {
  constructor(@Inject(DB) private readonly db: Database) {}

  async execute<T>(actor: ActorContext, fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(actor.propertyId)) {
      throw new Error('Refusing to open a unit of work with a non-UUID property id');
    }
    if (!UUID_RE.test(actor.userId)) {
      throw new Error('Refusing to open a unit of work with a non-UUID user id');
    }

    return this.db.transaction(async (tx) => {
      // Both GUCs are transaction-local (the `true`), so they cannot bleed into
      // the next caller that borrows this pooled connection.
      await tx.execute(sql`SELECT set_config('app.property_id', ${actor.propertyId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id', ${actor.userId}, true)`);

      const audits: AuditEntry[] = [];
      const events: DomainEvent[] = [];

      const uow: UnitOfWork = {
        tx,
        propertyId: actor.propertyId,
        userId: actor.userId,
        audit: (entry) => void audits.push(entry),
        emit: (event) => void events.push(event),
      };

      const result = await fn(uow);

      // Flush INSIDE the transaction. If fn() threw, we never get here and both
      // the domain change and its audit/events are rolled back together.
      if (audits.length > 0) {
        await tx.insert(auditLog).values(
          audits.map((a) => ({
            id: uuidv7(),
            propertyId: actor.propertyId,
            userId: actor.userId,
            action: a.action,
            entityType: a.entityType,
            entityId: a.entityId,
            before: a.before === undefined ? null : (a.before as never),
            after: a.after === undefined ? null : (a.after as never),
            reason: a.reason ?? null,
          })),
        );
      }

      if (events.length > 0) {
        await tx.insert(outboxEvents).values(
          events.map((e) => ({
            // uuidv7 is time-ordered, so the relay drains events in the order they
            // happened without needing a separate sequence column.
            id: uuidv7(),
            aggregateType: e.aggregateType,
            aggregateId: e.aggregateId,
            eventType: e.eventType,
            payload: {
              ...e.payload,
              propertyId: actor.propertyId,
              userId: actor.userId,
            } as never,
          })),
        );
      }

      return result;
    });
  }
}
