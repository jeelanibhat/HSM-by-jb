/**
 * Shared kernel — PUBLIC API.
 *
 * Domain modules import from here, never from the files directly.
 */
export { SharedModule } from './shared.module';
export { TransactionalUnitOfWork } from './unit-of-work';
export type { ActorContext, AuditEntry, UnitOfWork } from './unit-of-work';

export { EventBus } from './events/event-bus';
export type { EventHandler } from './events/event-bus';
export { EVENT_TYPES } from './events/domain-event';
export type { DomainEvent, EventType, PublishedEvent } from './events/domain-event';

export { OutboxRelay } from './outbox/outbox.relay';
export { PUB_SUB, TOPIC } from './events/pubsub';
