import { test as base, expect, type Page } from '@playwright/test';
import type postgres from 'postgres';
import { db, PASSWORD, resetHotel } from './db';
import type { Role } from './global-setup';

const API = process.env['E2E_API_URL'] ?? 'http://localhost:4000';

/**
 * A signed-in page per role, plus a database handle for arranging fixtures and
 * asserting on the truth underneath the UI.
 *
 * Every test resets the hotel first. Specs that book rooms and advance the trading
 * day cannot be allowed to leak into the next one — that is how an E2E suite starts
 * passing or failing depending on the order it happened to run in.
 */
type Fixtures = {
  sql: postgres.Sql;
  asRole: (role: Role) => Promise<Page>;
};

/**
 * Log in over the API and hand back the httpOnly refresh cookie.
 *
 * Each call mints a FRESH token family. That is the whole point: refresh tokens rotate
 * and the server revokes a family on reuse, so a shared, saved cookie would be spent
 * by the first test and get the second test logged out. See global-setup.ts.
 */
async function freshRefreshCookie(role: Role): Promise<string> {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation($i: LoginInput!) { login(input: $i) { accessToken } }`,
      variables: { i: { email: `${role}@hotelos.dev`, password: PASSWORD } },
    }),
  });

  const body = await res.json();
  if (!body.data?.login?.accessToken) {
    throw new Error(`Could not sign in as ${role}: ${JSON.stringify(body.errors)}`);
  }

  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /hotelos_rt=([^;]+)/.exec(setCookie);

  if (!match) throw new Error(`No refresh cookie returned for ${role}`);
  return match[1]!;
}

export const test = base.extend<Fixtures>({
  sql: async ({}, use) => {
    const sql = db();
    await resetHotel(sql);

    await use(sql);

    await sql.end();
  },

  asRole: async ({ browser, baseURL }, use) => {
    const pages: Page[] = [];

    await use(async (role: Role) => {
      const context = await browser.newContext({ baseURL });

      /**
       * Plant the refresh cookie the way the API set it. The app boots with NO access
       * token — it only ever lives in memory — and silently mints one from this cookie,
       * exactly as a returning receptionist's browser does. That is worth exercising:
       * if silent refresh broke, every test here would fail.
       */
      await context.addCookies([
        {
          name: 'hotelos_rt',
          value: await freshRefreshCookie(role),
          domain: 'localhost',
          path: '/graphql',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ]);

      const page = await context.newPage();
      pages.push(page);
      return page;
    });

    for (const p of pages) await p.context().close();
  },
});

export { expect };

/** Book a stay through the UI and return the confirmation number. */
export async function bookThroughUi(
  page: Page,
  opts: {
    firstName: string;
    lastName: string;
    typeCode: string;
    arrival: string;
    departure: string;
  },
): Promise<string> {
  await page.goto('/reservations/new');

  await page.getByLabel('Arrival').fill(opts.arrival);
  await page.getByLabel('Departure').fill(opts.departure);

  /**
   * Select by the RADIO's accessible name, not the label's textContent.
   *
   * textContent concatenates the spans with no separator — "DeluxeDLXup to 48 free" —
   * so a word-boundary match on the code silently never fires. The accessible name is
   * properly spaced, which is also the string a screen reader announces. Assert on what
   * a user perceives, not on raw DOM text.
   */
  const type = roomTypeRadio(page, opts.typeCode);

  /**
   * Wait for it to become selectable. Apollo serves the cached availability first
   * (cache-and-network), so a type that was sold out a moment ago renders DISABLED for
   * a beat before the fresh count arrives. Racing that produces a "disabled element"
   * timeout that looks like a product bug and is not one.
   *
   * If it never enables, the type really is full — and the message says so.
   */
  await expect(type, `${opts.typeCode} is sold out for ${opts.arrival}→${opts.departure}`)
    .toBeEnabled({ timeout: 25_000 });

  await type.check();

  await page.getByPlaceholder('First name').fill(opts.firstName);
  await page.getByPlaceholder('Last name').fill(opts.lastName);

  await page.getByRole('button', { name: /^Book/ }).click();

  const confirmation = page.locator('text=/^HTL-\\d+$/');
  await expect(confirmation).toBeVisible({ timeout: 20_000 });

  return (await confirmation.textContent())!.trim();
}

/** The room-type radio on the booking form, by its code (STD / DLX / SUITE). */
export function roomTypeRadio(page: Page, typeCode: string) {
  return page.getByRole('radio', { name: new RegExp(`\\b${typeCode}\\b`) });
}

/**
 * How many rooms of a type are free on the tightest night of the stay — the number the
 * form shows. Returns 0 when the type reads "sold out".
 *
 * Read the radio's aria-label, never the label's textContent. textContent runs the spans
 * together — "SuiteSUITEup to 43 free" for a 4-guest suite with 3 free — and /(\d+) free/
 * happily returns FORTY-THREE. A test that then "fills the hotel" books 43 suites, and the
 * failure surfaces nowhere near the bug.
 */
export async function roomsFree(page: Page, typeCode: string): Promise<number> {
  const name = (await roomTypeRadio(page, typeCode).getAttribute('aria-label')) ?? '';

  if (/sold out/i.test(name)) return 0;

  const match = /(\d+) free/.exec(name);
  return match ? Number(match[1]) : 0;
}

/** Open the front desk on a given tab. */
export async function frontDesk(page: Page, tab: 'Arrivals' | 'Departures' | 'In house') {
  await page.goto('/front-desk');
  await page.getByRole('button', { name: new RegExp(`^${tab}`) }).click();
}

/** The row for a guest on the front-desk board. */
export function guestRow(page: Page, name: string) {
  return page.locator('tr').filter({ hasText: name });
}

/**
 * The app's own alerts. Next.js renders a permanently-empty route announcer with
 * role="alert", so a bare getByRole('alert') is ambiguous.
 */
export function alertText(page: Page) {
  return page.getByRole('alert').filter({ hasText: /\S/ });
}

/**
 * The sidebar nav, scoped.
 *
 * The RBAC assertions mean "the navigation does not OFFER this to them" — and the same
 * link text appears in page content too (the dashboard has an "Open front desk" CTA).
 * Asserting on an unscoped link would pass or fail for the wrong reason.
 */
export function nav(page: Page) {
  return page.getByRole('complementary');
}
