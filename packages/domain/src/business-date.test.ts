import { describe, expect, it } from 'vitest';
import {
  addDays,
  businessDate,
  BusinessDateError,
  calendarDateInTimezone,
  compareDates,
  daysBetween,
  eachDateInclusive,
  eachDateInStay,
  nextDay,
  nightsBetween,
  previousDay,
  staysOverlap,
} from './business-date.js';

const bd = businessDate;

describe('businessDate parsing', () => {
  it('accepts a valid ISO date', () => {
    expect(bd('2026-07-11')).toBe('2026-07-11');
  });

  it('rejects wrong formats', () => {
    expect(() => bd('11-07-2026')).toThrow(BusinessDateError);
    expect(() => bd('2026-7-1')).toThrow(BusinessDateError);
    expect(() => bd('2026-07-11T00:00:00Z')).toThrow(BusinessDateError);
    expect(() => bd('')).toThrow(BusinessDateError);
  });

  it('rejects dates that do not exist — Date would silently roll these over', () => {
    expect(() => bd('2026-02-30')).toThrow(/not a real calendar date/);
    expect(() => bd('2026-13-01')).toThrow(/not a real calendar date/);
    expect(() => bd('2025-02-29')).toThrow(/not a real calendar date/); // 2025 not a leap year
  });

  it('accepts a real leap day', () => {
    expect(bd('2024-02-29')).toBe('2024-02-29');
  });
});

describe('arithmetic', () => {
  it('adds and subtracts days', () => {
    expect(addDays(bd('2026-07-11'), 5)).toBe('2026-07-16');
    expect(addDays(bd('2026-07-11'), -5)).toBe('2026-07-06');
    expect(addDays(bd('2026-07-11'), 0)).toBe('2026-07-11');
  });

  it('rolls over month and year boundaries', () => {
    expect(nextDay(bd('2026-01-31'))).toBe('2026-02-01');
    expect(nextDay(bd('2026-12-31'))).toBe('2027-01-01');
    expect(previousDay(bd('2026-01-01'))).toBe('2025-12-31');
  });

  it('crosses a leap day', () => {
    expect(nextDay(bd('2024-02-28'))).toBe('2024-02-29');
    expect(nextDay(bd('2024-02-29'))).toBe('2024-03-01');
    expect(nextDay(bd('2025-02-28'))).toBe('2025-03-01');
  });

  it('counts days between, signed', () => {
    expect(daysBetween(bd('2026-07-11'), bd('2026-07-14'))).toBe(3);
    expect(daysBetween(bd('2026-07-14'), bd('2026-07-11'))).toBe(-3);
    expect(daysBetween(bd('2026-07-11'), bd('2026-07-11'))).toBe(0);
  });

  it('rejects a non-integer day count', () => {
    expect(() => addDays(bd('2026-07-11'), 1.5)).toThrow(BusinessDateError);
  });
});

/**
 * The DST trap. A naive implementation using local-time Date arithmetic returns
 * 23 or 25 hours across a DST boundary and silently drops or duplicates a night.
 * We anchor to UTC, so a stay across a spring-forward is still exactly N nights.
 */
describe('DST and timezone edges (TDD §8.2)', () => {
  it('counts nights correctly across US spring-forward', () => {
    // 2026-03-08 02:00 America/New_York — clocks jump to 03:00
    expect(nightsBetween(bd('2026-03-07'), bd('2026-03-09'))).toBe(2);
    expect(daysBetween(bd('2026-03-07'), bd('2026-03-09'))).toBe(2);
  });

  it('counts nights correctly across US fall-back', () => {
    // 2026-11-01 02:00 America/New_York — clocks repeat 01:00
    expect(nightsBetween(bd('2026-10-31'), bd('2026-11-02'))).toBe(2);
  });

  it('counts nights correctly across EU DST', () => {
    expect(nightsBetween(bd('2026-03-28'), bd('2026-03-30'))).toBe(2);
    expect(nightsBetween(bd('2026-10-24'), bd('2026-10-26'))).toBe(2);
  });

  it('enumerates every night across a DST boundary without dropping one', () => {
    const nights = eachDateInStay(bd('2026-03-07'), bd('2026-03-10'));
    expect(nights).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
  });

  it('a 365-night stay is exactly 365 nights even crossing two DST switches', () => {
    expect(nightsBetween(bd('2026-01-01'), bd('2027-01-01'))).toBe(365);
    expect(eachDateInStay(bd('2026-01-01'), bd('2027-01-01'))).toHaveLength(365);
  });
});

describe('nightsBetween — half-open [arrival, departure)', () => {
  it('arriving the 1st and departing the 3rd is 2 nights', () => {
    expect(nightsBetween(bd('2026-07-01'), bd('2026-07-03'))).toBe(2);
  });

  it('a one-night stay is 1', () => {
    expect(nightsBetween(bd('2026-07-01'), bd('2026-07-02'))).toBe(1);
  });

  it('rejects a same-day or reversed stay — matches the DB CHECK constraint', () => {
    expect(() => nightsBetween(bd('2026-07-01'), bd('2026-07-01'))).toThrow(/must be after/);
    expect(() => nightsBetween(bd('2026-07-03'), bd('2026-07-01'))).toThrow(/must be after/);
  });
});

describe('eachDateInStay — the nights we post room charges for', () => {
  it('excludes the departure date — you are never charged for checkout day', () => {
    expect(eachDateInStay(bd('2026-07-01'), bd('2026-07-04'))).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ]);
  });

  it('returns exactly nightsBetween() entries', () => {
    const arrival = bd('2026-07-01');
    const departure = bd('2026-07-15');
    expect(eachDateInStay(arrival, departure)).toHaveLength(nightsBetween(arrival, departure));
  });

  it('returns empty for a zero-length range', () => {
    expect(eachDateInStay(bd('2026-07-01'), bd('2026-07-01'))).toEqual([]);
  });
});

describe('eachDateInclusive — report ranges DO include the end date', () => {
  it('includes both endpoints', () => {
    expect(eachDateInclusive(bd('2026-07-01'), bd('2026-07-03'))).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
    ]);
  });

  it('a single day is one entry', () => {
    expect(eachDateInclusive(bd('2026-07-01'), bd('2026-07-01'))).toEqual(['2026-07-01']);
  });

  it('an inverted range is empty, not an infinite loop', () => {
    expect(eachDateInclusive(bd('2026-07-03'), bd('2026-07-01'))).toEqual([]);
  });
});

/**
 * Same-day turnover is THE availability edge case (TDD §8.2): guest A checks out
 * on the 3rd, guest B checks in on the 3rd, same room. Half-open intervals mean
 * that is not an overlap — and the room must be sellable.
 */
describe('staysOverlap — half-open, so same-day turnover is legal', () => {
  it('allows same-day turnover: A [01,03) and B [03,05) do not overlap', () => {
    expect(staysOverlap(bd('2026-07-01'), bd('2026-07-03'), bd('2026-07-03'), bd('2026-07-05'))).toBe(
      false,
    );
  });

  it('detects a genuine one-night overlap', () => {
    expect(staysOverlap(bd('2026-07-01'), bd('2026-07-04'), bd('2026-07-03'), bd('2026-07-05'))).toBe(
      true,
    );
  });

  it('detects a fully-contained stay', () => {
    expect(staysOverlap(bd('2026-07-01'), bd('2026-07-10'), bd('2026-07-03'), bd('2026-07-05'))).toBe(
      true,
    );
  });

  it('detects identical stays', () => {
    expect(staysOverlap(bd('2026-07-01'), bd('2026-07-03'), bd('2026-07-01'), bd('2026-07-03'))).toBe(
      true,
    );
  });

  it('is symmetric', () => {
    const a: [string, string] = ['2026-07-01', '2026-07-04'];
    const b: [string, string] = ['2026-07-03', '2026-07-05'];
    expect(staysOverlap(bd(a[0]), bd(a[1]), bd(b[0]), bd(b[1]))).toBe(
      staysOverlap(bd(b[0]), bd(b[1]), bd(a[0]), bd(a[1])),
    );
  });

  it('treats fully-disjoint stays as non-overlapping', () => {
    expect(staysOverlap(bd('2026-07-01'), bd('2026-07-03'), bd('2026-07-10'), bd('2026-07-12'))).toBe(
      false,
    );
  });
});

describe('compareDates', () => {
  it('orders dates', () => {
    expect(compareDates(bd('2026-07-01'), bd('2026-07-02'))).toBe(-1);
    expect(compareDates(bd('2026-07-02'), bd('2026-07-01'))).toBe(1);
    expect(compareDates(bd('2026-07-01'), bd('2026-07-01'))).toBe(0);
  });

  it('sorts correctly as plain strings across year boundaries', () => {
    const sorted = [bd('2027-01-01'), bd('2026-12-31'), bd('2026-02-01')].sort(compareDates);
    expect(sorted).toEqual(['2026-02-01', '2026-12-31', '2027-01-01']);
  });
});

describe('calendarDateInTimezone', () => {
  it('resolves the property-local date, not the server date', () => {
    // 2026-07-11 20:30 UTC is already 2026-07-12 in Asia/Kolkata (+05:30).
    const instant = new Date('2026-07-11T20:30:00Z');
    expect(calendarDateInTimezone('Asia/Kolkata', instant)).toBe('2026-07-12');
    expect(calendarDateInTimezone('UTC', instant)).toBe('2026-07-11');
    expect(calendarDateInTimezone('America/New_York', instant)).toBe('2026-07-11');
  });

  it('handles the day rolling backwards west of UTC', () => {
    // 2026-07-11 02:00 UTC is still 2026-07-10 in Los Angeles (−07:00).
    const instant = new Date('2026-07-11T02:00:00Z');
    expect(calendarDateInTimezone('America/Los_Angeles', instant)).toBe('2026-07-10');
  });
});
