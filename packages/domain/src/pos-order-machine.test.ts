import { describe, expect, it } from 'vitest';
import { POS_ORDER_STATUSES, type PosOrderStatus } from './enums.js';
import {
  assertOrderTransition,
  canTransitionOrder,
  IllegalOrderTransitionError,
  isEditable,
  orderSubtotalMinor,
} from './pos-order-machine.js';

describe('POS order machine', () => {
  describe('the working path', () => {
    it('an open order can be charged to a room', () => {
      expect(canTransitionOrder('OPEN', 'CHARGED')).toBe(true);
    });

    it('an open order can be voided — the table left, nobody pays', () => {
      expect(canTransitionOrder('OPEN', 'VOID')).toBe(true);
    });
  });

  describe('CHARGED is terminal — the guest has the bill', () => {
    it.each(POS_ORDER_STATUSES)('refuses CHARGED → %s', (to) => {
      expect(() => assertOrderTransition('CHARGED', to)).toThrow(IllegalOrderTransitionError);
    });

    it('will not let a billed order be voided away', () => {
      // Otherwise the restaurant's record says "nobody was charged" while the guest's
      // folio says they were — and the guest may already have paid and left.
      expect(() => assertOrderTransition('CHARGED', 'VOID')).toThrow(/already on the guest/i);
    });

    it('points at the folio reversal instead of just refusing', () => {
      expect(() => assertOrderTransition('CHARGED', 'VOID')).toThrow(/reverse the charge/i);
    });
  });

  describe('VOID is terminal', () => {
    it.each(POS_ORDER_STATUSES)('refuses VOID → %s', (to) => {
      expect(() => assertOrderTransition('VOID', to)).toThrow(IllegalOrderTransitionError);
    });

    it('tells the waiter to start a new order', () => {
      expect(() => assertOrderTransition('VOID', 'CHARGED')).toThrow(/start a new one/i);
    });
  });

  describe('every transition, legal and illegal', () => {
    const LEGAL = new Set(['OPEN→CHARGED', 'OPEN→VOID']);

    const pairs = POS_ORDER_STATUSES.flatMap((from) =>
      POS_ORDER_STATUSES.map((to) => [from, to] as [PosOrderStatus, PosOrderStatus]),
    );

    it.each(pairs)('%s → %s', (from, to) => {
      const legal = LEGAL.has(`${from}→${to}`);
      expect(canTransitionOrder(from, to)).toBe(legal);

      if (legal) {
        expect(() => assertOrderTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertOrderTransition(from, to)).toThrow(IllegalOrderTransitionError);
      }
    });

    it('never lets an order be charged twice', () => {
      // The double-tap on "send to room". The machine refuses; the service also has a
      // row lock, and the folio line carries the order id. Three layers, on purpose.
      expect(canTransitionOrder('CHARGED', 'CHARGED')).toBe(false);
    });
  });

  describe('editing', () => {
    it('is allowed only while the order is open', () => {
      expect(isEditable('OPEN')).toBe(true);
      expect(isEditable('CHARGED')).toBe(false);
      expect(isEditable('VOID')).toBe(false);
    });
  });

  describe('the subtotal', () => {
    it('sums quantity × unit price in minor units', () => {
      const total = orderSubtotalMinor([
        { quantity: 2, unitPriceMinor: 45_000 }, // 2 × ₹450
        { quantity: 1, unitPriceMinor: 12_500 }, // 1 × ₹125
      ]);

      expect(total).toBe(102_500); // ₹1,025.00
    });

    it('is zero for an empty order', () => {
      expect(orderSubtotalMinor([])).toBe(0);
    });

    it('loses nothing to floating point', () => {
      // ₹0.10 × 3 is ₹0.30. In rupees-as-floats it is 0.30000000000000004, and the
      // guest is the one who notices.
      const total = orderSubtotalMinor([{ quantity: 3, unitPriceMinor: 10 }]);
      expect(total).toBe(30);
      expect(Number.isInteger(total)).toBe(true);
    });

    it('stays exact across a long tab', () => {
      const lines = Array.from({ length: 100 }, () => ({ quantity: 3, unitPriceMinor: 3_333 }));
      expect(orderSubtotalMinor(lines)).toBe(999_900);
    });
  });
});
