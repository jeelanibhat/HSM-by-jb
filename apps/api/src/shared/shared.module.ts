import { Global, Module } from '@nestjs/common';
import { EventBus } from './events/event-bus';
import { EventPubSubBridge, PUB_SUB, pubSubProvider } from './events/pubsub';
import { OutboxRelay } from './outbox/outbox.relay';
import { TransactionalUnitOfWork } from './unit-of-work';

/**
 * The shared kernel (TDD §2): event bus (outbox), audit, money, dates, ids.
 *
 * Global because every domain module needs the unit of work — and a module that
 * had to remember to import it is a module that can forget to, and then write a
 * mutation with no audit trail.
 */
@Global()
@Module({
  providers: [
    TransactionalUnitOfWork,
    EventBus,
    OutboxRelay,
    pubSubProvider,
    EventPubSubBridge,
  ],
  exports: [TransactionalUnitOfWork, EventBus, OutboxRelay, PUB_SUB],
})
export class SharedModule {}
