import { describe, expect, it } from 'vitest';
import {
  CHANNEL_DELIVERY_STATUSES,
  CHANNEL_OUTBOUND_STATUSES,
  type ChannelDeliveryStatus,
  type ChannelOutboundStatus,
} from './enums.js';
import {
  assertChannelDeliveryTransition,
  assertChannelPushTransition,
  canDeliveryTransition,
  canPushTransition,
  IllegalChannelTransitionError,
  nextPushDelayMs,
} from './channel-sync-machine.js';

describe('channel sync machines', () => {
  describe('outbound push — the working path', () => {
    it('a queued push can be sent', () => {
      expect(canPushTransition('PENDING', 'SENT')).toBe(true);
    });

    it('a queued push can fail', () => {
      expect(canPushTransition('PENDING', 'FAILED')).toBe(true);
    });

    it('a failed push goes back on the queue to be retried', () => {
      expect(canPushTransition('FAILED', 'PENDING')).toBe(true);
    });
  });

  describe('outbound push — SENT is terminal', () => {
    it.each(CHANNEL_OUTBOUND_STATUSES)('refuses SENT → %s', (to) => {
      expect(() => assertChannelPushTransition('SENT', to)).toThrow(IllegalChannelTransitionError);
    });

    it('explains that the next change makes a new push', () => {
      expect(() => assertChannelPushTransition('SENT', 'PENDING')).toThrow(/already acknowledged/i);
    });

    it('never re-sends the same acknowledged snapshot', () => {
      expect(canPushTransition('SENT', 'SENT')).toBe(false);
    });
  });

  describe('outbound push — every transition, legal and illegal', () => {
    const LEGAL = new Set(['PENDING→SENT', 'PENDING→FAILED', 'FAILED→PENDING']);

    const pairs = CHANNEL_OUTBOUND_STATUSES.flatMap((from) =>
      CHANNEL_OUTBOUND_STATUSES.map(
        (to) => [from, to] as [ChannelOutboundStatus, ChannelOutboundStatus],
      ),
    );

    it.each(pairs)('%s → %s', (from, to) => {
      const legal = LEGAL.has(`${from}→${to}`);
      expect(canPushTransition(from, to)).toBe(legal);

      if (legal) {
        expect(() => assertChannelPushTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertChannelPushTransition(from, to)).toThrow(IllegalChannelTransitionError);
      }
    });
  });

  describe('inbound delivery — the working path', () => {
    it('a received booking can be confirmed', () => {
      expect(canDeliveryTransition('RECEIVED', 'CONFIRMED')).toBe(true);
    });

    it('a received booking can be rejected — the room was gone', () => {
      expect(canDeliveryTransition('RECEIVED', 'REJECTED')).toBe(true);
    });

    it('a received booking can be marked a duplicate delivery', () => {
      expect(canDeliveryTransition('RECEIVED', 'DUPLICATE')).toBe(true);
    });
  });

  describe('inbound delivery — every end state is terminal', () => {
    const terminal: ChannelDeliveryStatus[] = ['CONFIRMED', 'REJECTED', 'DUPLICATE'];

    it.each(terminal)('%s admits no further transition', (from) => {
      for (const to of CHANNEL_DELIVERY_STATUSES) {
        expect(canDeliveryTransition(from, to)).toBe(false);
        expect(() => assertChannelDeliveryTransition(from, to)).toThrow(
          IllegalChannelTransitionError,
        );
      }
    });

    it('a redelivery does not overwrite a confirmed booking', () => {
      // The reservation from the first delivery must stand.
      expect(() => assertChannelDeliveryTransition('CONFIRMED', 'DUPLICATE')).toThrow(
        /already has an outcome/i,
      );
    });
  });

  describe('retry back-off', () => {
    it('grows exponentially with the attempt count', () => {
      expect(nextPushDelayMs(1)).toBe(2_000);
      expect(nextPushDelayMs(2)).toBe(4_000);
      expect(nextPushDelayMs(3)).toBe(8_000);
    });

    it('is capped so a long outage does not back off forever', () => {
      expect(nextPushDelayMs(50)).toBe(5 * 60_000);
    });

    it('never returns a negative or sub-base delay for the first attempt', () => {
      expect(nextPushDelayMs(0)).toBe(2_000);
      expect(nextPushDelayMs(1)).toBe(2_000);
    });
  });
});
