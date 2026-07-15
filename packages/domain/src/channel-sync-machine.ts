/**
 * Channel sync machines — the two little lifecycles a channel manager runs.
 *
 * OUTBOUND is one availability/rate push. INBOUND is one booking an OTA delivered.
 * They are kept as separate machines because they fail in different ways and for
 * different reasons: a push fails because the channel was unreachable and should be
 * retried; a delivery fails because we could not honour the booking and must NOT be
 * retried into existence.
 *
 * As with every other machine in this package, the transition table is the whole
 * point — the database (CHECK constraints) and the services enforce the same edges,
 * but this is the one place that says, in one screen, what may follow what.
 */
import type { ChannelDeliveryStatus, ChannelOutboundStatus } from './enums.js';

// ── Outbound push ─────────────────────────────────────────────────────────────

const OUTBOUND: Readonly<Record<ChannelOutboundStatus, readonly ChannelOutboundStatus[]>> = {
  PENDING: ['SENT', 'FAILED'],

  /** Terminal. The channel acknowledged this snapshot. */
  SENT: [],

  /** A failed push goes back on the queue. That is the only reason FAILED is not terminal. */
  FAILED: ['PENDING'],
};

// ── Inbound delivery ──────────────────────────────────────────────────────────

const INBOUND: Readonly<Record<ChannelDeliveryStatus, readonly ChannelDeliveryStatus[]>> = {
  RECEIVED: ['CONFIRMED', 'REJECTED', 'DUPLICATE'],

  /** All terminal. A booking's outcome is a fact about one delivery. */
  CONFIRMED: [],
  REJECTED: [],
  DUPLICATE: [],
};

export class IllegalChannelTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    reason?: string,
  ) {
    super(reason ?? `Illegal channel transition: ${from} → ${to}`);
    this.name = 'IllegalChannelTransitionError';
  }
}

export function canPushTransition(
  from: ChannelOutboundStatus,
  to: ChannelOutboundStatus,
): boolean {
  return OUTBOUND[from].includes(to);
}

export function assertChannelPushTransition(
  from: ChannelOutboundStatus,
  to: ChannelOutboundStatus,
): void {
  if (from === 'SENT') {
    throw new IllegalChannelTransitionError(
      from,
      to,
      'That push was already acknowledged. The next inventory change makes a new push — this row is a record of one that landed.',
    );
  }

  if (!canPushTransition(from, to)) throw new IllegalChannelTransitionError(from, to);
}

export function canDeliveryTransition(
  from: ChannelDeliveryStatus,
  to: ChannelDeliveryStatus,
): boolean {
  return INBOUND[from].includes(to);
}

export function assertChannelDeliveryTransition(
  from: ChannelDeliveryStatus,
  to: ChannelDeliveryStatus,
): void {
  if (from !== 'RECEIVED') {
    throw new IllegalChannelTransitionError(
      from,
      to,
      'That booking already has an outcome. A redelivery is a DUPLICATE, not a change to the booking that stands.',
    );
  }

  if (!canDeliveryTransition(from, to)) throw new IllegalChannelTransitionError(from, to);
}

/**
 * Back-off for the next retry of a failed push, in milliseconds.
 *
 * Exponential on the attempt count, capped: a channel that has been down for an hour
 * should be polled every few minutes, not every few minutes doubling forever. The cap
 * also bounds how stale availability can get once the channel recovers — the moment it
 * answers, the newest snapshot lands.
 */
export function nextPushDelayMs(attempts: number): number {
  const base = 2_000; // 2s, 4s, 8s, 16s, …
  const cap = 5 * 60_000; // 5 minutes
  return Math.min(cap, base * 2 ** Math.max(0, attempts - 1));
}
