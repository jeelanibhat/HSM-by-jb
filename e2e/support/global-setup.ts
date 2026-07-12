import { db, resetHotel } from './db';

export const ROLES = ['admin', 'manager', 'frontdesk', 'housekeeping', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Reset the hotel to a known morning before the suite runs.
 *
 * NOTE WHAT IS *NOT* HERE: saved storageState per role.
 *
 * TDD §8.3 suggests it, and it is the standard Playwright pattern — but it is
 * incompatible with the auth this system actually has. Refresh tokens ROTATE and the
 * server detects reuse: presenting a spent token revokes the entire family (step 3).
 * A storageState file captures ONE refresh token; the first test to restore it spends
 * that token, and the second test replays it, trips the reuse detector, and gets the
 * session it just restored revoked underneath it.
 *
 * That is the security feature working exactly as designed. So each test context logs
 * in fresh over the API instead and gets its own token family — see `asRole` in
 * fixtures.ts. It costs one HTTP round trip per test, which is cheaper than the
 * five-second UI login the storageState pattern exists to avoid.
 */
async function globalSetup(): Promise<void> {
  const sql = db();
  try {
    await resetHotel(sql);
  } finally {
    await sql.end();
  }
}

export default globalSetup;
