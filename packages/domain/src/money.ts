/**
 * Money — integer minor units only. Floats never touch a folio.
 *
 * Stored as BIGINT minor units + CHAR(3) currency (TDD §4). We model minor
 * units as `number`: JS safe integers reach ±9.007e15 minor units, i.e. ±90
 * trillion major units, which no folio will ever approach. Every constructor
 * asserts the invariant so a float can't sneak in through an untyped boundary.
 */

export type Currency = string; // ISO-4217, e.g. 'INR', 'USD'

export interface Money {
  readonly minor: number;
  readonly currency: Currency;
}

export class MoneyError extends Error {}

/** Minor-unit exponent per currency. Most are 2; these are the exceptions we care about. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);
const THREE_DECIMAL = new Set(['BHD', 'KWD', 'OMR', 'JOD', 'TND']);

export function minorUnitExponent(currency: Currency): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

export function money(minor: number, currency: Currency): Money {
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError(`Money.minor must be a safe integer, got ${minor}`);
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new MoneyError(`Invalid ISO-4217 currency: ${currency}`);
  }
  return { minor, currency };
}

export function zero(currency: Currency): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.minor, a.currency);
}

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce<Money>((acc, m) => add(acc, m), zero(currency));
}

export function isZero(a: Money): boolean {
  return a.minor === 0;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

/**
 * Multiply by a quantity (e.g. room rate × nights). Rounds half-away-from-zero,
 * which is what finance expects and what `Math.round` does NOT do for negatives.
 */
export function multiply(a: Money, factor: number): Money {
  return money(roundHalfAwayFromZero(a.minor * factor), a.currency);
}

export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Split an amount into n parts without losing or inventing a single minor unit.
 * The remainder is distributed one unit at a time across the leading parts, so
 * 100 / 3 → [34, 33, 33]. Used for split folios and per-night rate allocation.
 */
export function allocate(a: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new MoneyError(`allocate() needs a positive integer part count, got ${parts}`);
  }
  const sign = a.minor < 0 ? -1 : 1;
  const abs = Math.abs(a.minor);
  const base = Math.floor(abs / parts);
  let remainder = abs - base * parts;

  return Array.from({ length: parts }, () => {
    const extra = remainder > 0 ? 1 : 0;
    remainder -= extra;
    return money(sign * (base + extra), a.currency);
  });
}

/**
 * Split by weights (e.g. routing a charge across folios 70/30). Largest-remainder
 * method: the leftover minor units go to the parts with the biggest fractional loss,
 * so the parts always sum exactly back to `a`.
 */
export function allocateByWeights(a: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new MoneyError('allocateByWeights() needs at least one weight');
  if (weights.some((w) => w < 0)) throw new MoneyError('Weights must be non-negative');

  const total = weights.reduce((s, w) => s + w, 0);
  if (total === 0) throw new MoneyError('Weights must not sum to zero');

  const sign = a.minor < 0 ? -1 : 1;
  const abs = Math.abs(a.minor);

  const exact = weights.map((w) => (abs * w) / total);
  const floors = exact.map((e) => Math.floor(e));
  let remainder = abs - floors.reduce((s, f) => s + f, 0);

  // Distribute the remainder to the largest fractional parts first.
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((x, y) => y.frac - x.frac || x.i - y.i);

  const result = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    result[i] = (result[i] ?? 0) + 1;
    remainder -= 1;
  }

  return result.map((minor) => money(sign * minor, a.currency));
}

/**
 * Tax from a rate in basis points (1 bps = 0.01%).
 *
 * EXCLUSIVE: tax sits on top of the amount   → tax = amount × bps/10000
 * INCLUSIVE: tax is already inside the amount → tax = amount × bps/(10000+bps)
 *
 * The inclusive case is the one people get wrong; it is why GST-inclusive rack
 * rates reconcile to the paisa (TDD §8.2 "tax calculation (inclusive/exclusive)").
 */
export function taxFromBps(
  amount: Money,
  rateBps: number,
  mode: 'INCLUSIVE' | 'EXCLUSIVE',
): Money {
  if (!Number.isInteger(rateBps) || rateBps < 0) {
    throw new MoneyError(`rateBps must be a non-negative integer, got ${rateBps}`);
  }
  const minor =
    mode === 'EXCLUSIVE'
      ? (amount.minor * rateBps) / 10_000
      : (amount.minor * rateBps) / (10_000 + rateBps);

  return money(roundHalfAwayFromZero(minor), amount.currency);
}

/** For an inclusive-tax amount, the portion that is not tax. */
export function netOfInclusiveTax(amount: Money, rateBps: number): Money {
  return subtract(amount, taxFromBps(amount, rateBps, 'INCLUSIVE'));
}

/** Human-readable, locale-aware. Presentation only — never round-trip through this. */
export function format(a: Money, locale = 'en-IN'): string {
  const exp = minorUnitExponent(a.currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: a.currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(a.minor / 10 ** exp);
}

/** Parse a major-unit decimal string ('1234.50') into minor units. Input-boundary only. */
export function fromMajorString(value: string, currency: Currency): Money {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError(`Cannot parse money from '${value}'`);
  }
  const exp = minorUnitExponent(currency);
  const negative = trimmed.startsWith('-');
  const [whole = '0', frac = ''] = trimmed.replace('-', '').split('.');

  if (frac.length > exp) {
    throw new MoneyError(`'${value}' has more precision than ${currency} allows (${exp} dp)`);
  }
  const padded = frac.padEnd(exp, '0');
  const minor = Number(whole) * 10 ** exp + Number(padded || '0');

  return money(negative ? -minor : minor, currency);
}
