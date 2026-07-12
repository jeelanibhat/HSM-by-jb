/**
 * Money formatting for the browser.
 *
 * The client NEVER does arithmetic on money. It receives minor units from the
 * server, renders them, and sends minor units back. Every total, tax split and
 * balance is computed once, server-side, by @hotelos/domain — so the number on the
 * screen and the number in the ledger cannot drift apart.
 *
 * The one exception is parsing what a human typed, which is by definition a client
 * concern. It is deliberately strict.
 */

export function formatMinor(minor: number, currency = 'INR', locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/** Digits only, for tables where the currency symbol is in the header. */
export function formatMinorPlain(minor: number, locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

/**
 * Parse what a receptionist typed into minor units.
 *
 * Returns null rather than NaN or a guess. '3,500.50' → 350050. A silent
 * mis-parse here posts the wrong number to a guest's bill, so anything ambiguous
 * is rejected and the form tells them.
 */
export function parseMajorToMinor(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '');
  if (cleaned === '') return null;

  // At most two decimal places — no one pays a third of a paisa.
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;

  const [whole = '0', frac = ''] = cleaned.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));

  return Number.isSafeInteger(minor) ? minor : null;
}
