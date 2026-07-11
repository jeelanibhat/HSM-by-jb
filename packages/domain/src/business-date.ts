/**
 * Business date — "the single most important PMS concept" (TDD §6).
 *
 * A business date is a CALENDAR date with no time and no timezone. It is NOT
 * "today". A property's business date advances only when night audit runs, so a
 * hotel still posting at 02:00 is operating on the *previous* business date.
 *
 * We model it as a branded 'YYYY-MM-DD' string and do all arithmetic on a
 * UTC-anchored Date, so a machine in IST and a machine in UTC produce identical
 * results. Never construct one from `new Date()` in local time.
 */

declare const brand: unique symbol;
export type BusinessDate = string & { readonly [brand]: 'BusinessDate' };

export class BusinessDateError extends Error {}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function businessDate(value: string): BusinessDate {
  const match = ISO_DATE.exec(value);
  if (!match) {
    throw new BusinessDateError(`Business date must be YYYY-MM-DD, got '${value}'`);
  }
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  // Round-trip through UTC to reject 2025-02-30 and friends, which Date silently rolls over.
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new BusinessDateError(`'${value}' is not a real calendar date`);
  }
  return value as BusinessDate;
}

function toUtc(d: BusinessDate): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

function fromUtc(d: Date): BusinessDate {
  return d.toISOString().slice(0, 10) as BusinessDate;
}

export function addDays(d: BusinessDate, days: number): BusinessDate {
  if (!Number.isInteger(days)) throw new BusinessDateError('addDays() requires an integer');
  return fromUtc(new Date(toUtc(d).getTime() + days * MS_PER_DAY));
}

export function nextDay(d: BusinessDate): BusinessDate {
  return addDays(d, 1);
}

export function previousDay(d: BusinessDate): BusinessDate {
  return addDays(d, -1);
}

/** Signed day count from `a` to `b`. Also the night count for [arrival, departure). */
export function daysBetween(a: BusinessDate, b: BusinessDate): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / MS_PER_DAY);
}

/**
 * Nights in a stay. Hotel convention: the stay is the half-open interval
 * [arrival, departure) — arriving the 1st and departing the 3rd is 2 nights,
 * and the departure date itself is never charged.
 */
export function nightsBetween(arrival: BusinessDate, departure: BusinessDate): number {
  const nights = daysBetween(arrival, departure);
  if (nights <= 0) {
    throw new BusinessDateError(`Departure ${departure} must be after arrival ${arrival}`);
  }
  return nights;
}

export function compareDates(a: BusinessDate, b: BusinessDate): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isBefore(a: BusinessDate, b: BusinessDate): boolean {
  return a < b;
}

export function isAfter(a: BusinessDate, b: BusinessDate): boolean {
  return a > b;
}

export function isSameOrBefore(a: BusinessDate, b: BusinessDate): boolean {
  return a <= b;
}

/**
 * Every date in [from, to) — the nights of a stay, i.e. the dates a room charge
 * is posted for and the rows to lock in room_type_availability.
 */
export function eachDateInStay(arrival: BusinessDate, departure: BusinessDate): BusinessDate[] {
  const out: BusinessDate[] = [];
  for (let d = arrival; isBefore(d, departure); d = nextDay(d)) {
    out.push(d);
  }
  return out;
}

/** Inclusive range [from, to] — for reports, which do include the end date. */
export function eachDateInclusive(from: BusinessDate, to: BusinessDate): BusinessDate[] {
  if (isAfter(from, to)) return [];
  const out: BusinessDate[] = [];
  for (let d = from; isSameOrBefore(d, to); d = nextDay(d)) {
    out.push(d);
  }
  return out;
}

/** Do two stays overlap? Half-open, so checkout-day turnover is NOT an overlap. */
export function staysOverlap(
  aArrival: BusinessDate,
  aDeparture: BusinessDate,
  bArrival: BusinessDate,
  bDeparture: BusinessDate,
): boolean {
  return isBefore(aArrival, bDeparture) && isBefore(bArrival, aDeparture);
}

/**
 * The property's *calendar* date right now, in its own timezone. Use this only
 * to sanity-check a night-audit run ("you're advancing to a future date") —
 * never as a substitute for the stored business_date.
 */
export function calendarDateInTimezone(timezone: string, now: Date = new Date()): BusinessDate {
  // en-CA gives YYYY-MM-DD directly.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return businessDate(formatted);
}
