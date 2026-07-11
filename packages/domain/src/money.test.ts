import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  allocateByWeights,
  compare,
  format,
  fromMajorString,
  isZero,
  money,
  MoneyError,
  multiply,
  negate,
  netOfInclusiveTax,
  subtract,
  sum,
  taxFromBps,
  zero,
} from './money.js';

const inr = (minor: number) => money(minor, 'INR');

describe('money construction', () => {
  it('rejects non-integer minor units — floats never touch a folio', () => {
    expect(() => money(10.5, 'INR')).toThrow(MoneyError);
    expect(() => money(NaN, 'INR')).toThrow(MoneyError);
    expect(() => money(Infinity, 'INR')).toThrow(MoneyError);
  });

  it('rejects unsafe integers', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, 'INR')).toThrow(MoneyError);
  });

  it('rejects malformed currency codes', () => {
    expect(() => money(100, 'inr')).toThrow(MoneyError);
    expect(() => money(100, 'RUPEE')).toThrow(MoneyError);
    expect(() => money(100, '')).toThrow(MoneyError);
  });

  it('accepts zero and negatives (refunds, reversals)', () => {
    expect(zero('INR').minor).toBe(0);
    expect(inr(-500).minor).toBe(-500);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    expect(add(inr(1000), inr(250)).minor).toBe(1250);
    expect(subtract(inr(1000), inr(250)).minor).toBe(750);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(inr(100), money(100, 'USD'))).toThrow(/Currency mismatch/);
    expect(() => subtract(inr(100), money(100, 'USD'))).toThrow(/Currency mismatch/);
    expect(() => compare(inr(100), money(100, 'USD'))).toThrow(/Currency mismatch/);
  });

  it('sums an empty list to zero', () => {
    expect(sum([], 'INR')).toEqual(zero('INR'));
  });

  it('sums a list', () => {
    expect(sum([inr(100), inr(200), inr(300)], 'INR').minor).toBe(600);
  });

  it('negates', () => {
    expect(negate(inr(750)).minor).toBe(-750);
    expect(negate(inr(-750)).minor).toBe(750);
  });

  it('compares', () => {
    expect(compare(inr(100), inr(200))).toBe(-1);
    expect(compare(inr(200), inr(100))).toBe(1);
    expect(compare(inr(100), inr(100))).toBe(0);
  });

  it('multiplies by nights and rounds half away from zero', () => {
    expect(multiply(inr(350000), 3).minor).toBe(1_050_000); // 3 nights @ ₹3500
    expect(multiply(inr(101), 0.5).minor).toBe(51); // 50.5 → 51
    expect(multiply(inr(-101), 0.5).minor).toBe(-51); // −50.5 → −51, not −50
  });
});

describe('allocate — split without losing a paisa', () => {
  it('splits evenly when it divides cleanly', () => {
    expect(allocate(inr(900), 3).map((m) => m.minor)).toEqual([300, 300, 300]);
  });

  it('distributes the remainder to the leading parts', () => {
    expect(allocate(inr(100), 3).map((m) => m.minor)).toEqual([34, 33, 33]);
    expect(allocate(inr(1000), 3).map((m) => m.minor)).toEqual([334, 333, 333]);
  });

  it('always sums back to the original — no minor unit invented or lost', () => {
    for (const total of [1, 7, 100, 999, 1_000_001]) {
      for (const parts of [2, 3, 7, 11]) {
        const split = allocate(inr(total), parts);
        expect(sum(split, 'INR').minor).toBe(total);
        expect(split).toHaveLength(parts);
      }
    }
  });

  it('handles negatives (refund splits) and still sums exactly', () => {
    const split = allocate(inr(-100), 3);
    expect(split.map((m) => m.minor)).toEqual([-34, -33, -33]);
    expect(sum(split, 'INR').minor).toBe(-100);
  });

  it('rejects a non-positive part count', () => {
    expect(() => allocate(inr(100), 0)).toThrow(MoneyError);
    expect(() => allocate(inr(100), -1)).toThrow(MoneyError);
    expect(() => allocate(inr(100), 2.5)).toThrow(MoneyError);
  });
});

describe('allocateByWeights — split folio routing', () => {
  it('splits 70/30', () => {
    expect(allocateByWeights(inr(1000), [70, 30]).map((m) => m.minor)).toEqual([700, 300]);
  });

  it('gives the leftover unit to the largest fractional remainder', () => {
    // 100 × 1/3 = 33.33, ×1/3 = 33.33, ×1/3 = 33.33 → one unit left over
    const split = allocateByWeights(inr(100), [1, 1, 1]);
    expect(sum(split, 'INR').minor).toBe(100);
    expect(split.map((m) => m.minor)).toEqual([34, 33, 33]);
  });

  it('always sums back exactly, for awkward weights', () => {
    const split = allocateByWeights(inr(10_000), [1, 3, 7, 13]);
    expect(sum(split, 'INR').minor).toBe(10_000);
  });

  it('tolerates zero weights', () => {
    expect(allocateByWeights(inr(500), [1, 0]).map((m) => m.minor)).toEqual([500, 0]);
  });

  it('rejects empty, negative, or all-zero weights', () => {
    expect(() => allocateByWeights(inr(100), [])).toThrow(MoneyError);
    expect(() => allocateByWeights(inr(100), [-1, 2])).toThrow(MoneyError);
    expect(() => allocateByWeights(inr(100), [0, 0])).toThrow(MoneyError);
  });
});

describe('tax — the calculation people get wrong', () => {
  it('EXCLUSIVE: 12% GST sits on top', () => {
    // ₹1000.00 → ₹120.00 tax, guest pays ₹1120.00
    expect(taxFromBps(inr(100_000), 1200, 'EXCLUSIVE').minor).toBe(12_000);
  });

  it('INCLUSIVE: 12% GST is already inside the rack rate', () => {
    // ₹1120.00 inclusive → tax is ₹120.00, NOT ₹134.40
    expect(taxFromBps(inr(112_000), 1200, 'INCLUSIVE').minor).toBe(12_000);
  });

  it('inclusive and exclusive round-trip: net + tax === gross', () => {
    const gross = inr(112_000);
    const tax = taxFromBps(gross, 1200, 'INCLUSIVE');
    const net = netOfInclusiveTax(gross, 1200);

    expect(add(net, tax)).toEqual(gross);
    expect(net.minor).toBe(100_000);
  });

  it('round-trips at the paisa level for awkward amounts', () => {
    // 18% GST on a ₹1234.57 inclusive amount
    for (const grossMinor of [1, 99, 12_345, 123_457, 999_999]) {
      const gross = inr(grossMinor);
      const tax = taxFromBps(gross, 1800, 'INCLUSIVE');
      const net = netOfInclusiveTax(gross, 1800);
      expect(add(net, tax).minor).toBe(grossMinor);
    }
  });

  it('zero-rated items produce zero tax', () => {
    expect(taxFromBps(inr(100_000), 0, 'EXCLUSIVE').minor).toBe(0);
    expect(taxFromBps(inr(100_000), 0, 'INCLUSIVE').minor).toBe(0);
  });

  it('taxes a reversing (negative) line to a negative tax', () => {
    expect(taxFromBps(inr(-100_000), 1200, 'EXCLUSIVE').minor).toBe(-12_000);
  });

  it('rejects a negative or fractional bps rate', () => {
    expect(() => taxFromBps(inr(100), -1, 'EXCLUSIVE')).toThrow(MoneyError);
    expect(() => taxFromBps(inr(100), 12.5, 'EXCLUSIVE')).toThrow(MoneyError);
  });
});

describe('void reversals sum to zero (TDD §8.2)', () => {
  it('a charge and its reversing entry net to zero', () => {
    const charge = inr(350_000);
    const reversal = negate(charge);
    expect(isZero(sum([charge, reversal], 'INR'))).toBe(true);
  });

  it('a charge, its tax, and both reversals net to zero', () => {
    const charge = inr(350_000);
    const tax = taxFromBps(charge, 1200, 'EXCLUSIVE');
    const lines = [charge, tax, negate(charge), negate(tax)];
    expect(sum(lines, 'INR').minor).toBe(0);
  });
});

describe('fromMajorString — input boundary', () => {
  it('parses decimals into minor units', () => {
    expect(fromMajorString('1234.50', 'INR').minor).toBe(123_450);
    expect(fromMajorString('0.01', 'INR').minor).toBe(1);
    expect(fromMajorString('1000', 'INR').minor).toBe(100_000);
    expect(fromMajorString('-50.25', 'INR').minor).toBe(-5025);
  });

  it('respects zero-decimal currencies', () => {
    expect(fromMajorString('1500', 'JPY').minor).toBe(1500);
  });

  it('respects three-decimal currencies', () => {
    expect(fromMajorString('1.234', 'KWD').minor).toBe(1234);
  });

  it('rejects more precision than the currency allows', () => {
    expect(() => fromMajorString('10.999', 'INR')).toThrow(/precision/);
    expect(() => fromMajorString('10.5', 'JPY')).toThrow(/precision/);
  });

  it('rejects garbage', () => {
    expect(() => fromMajorString('abc', 'INR')).toThrow(MoneyError);
    expect(() => fromMajorString('', 'INR')).toThrow(MoneyError);
    expect(() => fromMajorString('1,234.50', 'INR')).toThrow(MoneyError);
  });
});

describe('format', () => {
  it('formats to the currency exponent', () => {
    // Non-breaking spaces vary by ICU build, so assert on the digits.
    expect(format(inr(123_450), 'en-IN')).toContain('1,234.50');
    expect(format(money(1500, 'JPY'), 'en-US')).toContain('1,500');
  });
});
