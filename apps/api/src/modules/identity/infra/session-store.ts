import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { VALKEY } from '../../../valkey/valkey.module';

/**
 * Refresh-token session store (TDD §3, §9: "session revocation list in Redis").
 *
 * Refresh tokens ROTATE: each use burns the old token and issues a new one. That
 * bounds the damage from a stolen token — but only if we can tell that a token
 * was used twice.
 *
 * Hence token FAMILIES. Every refresh descended from one login shares a family id.
 * We store exactly one live jti per family. On refresh:
 *
 *   - jti is the live one  → normal rotation. Burn it, issue the next.
 *   - jti is valid JWT but NOT live → it was already spent. Either the user
 *     replayed it, or an attacker stole it and one of them has already rotated.
 *     We cannot tell which, so we assume the worst and kill the ENTIRE family:
 *     both the thief and the victim are logged out, and the victim's next login
 *     re-establishes a clean family.
 *
 * Without family revocation, a stolen refresh token is a permanent backdoor: the
 * attacker just keeps rotating it, and the legitimate user never notices.
 */
@Injectable()
export class SessionStore {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  /** The single live token of a family. */
  private familyKey(userId: string, familyId: string): string {
    return `rt:${userId}:${familyId}`;
  }

  /** Index of a user's live families, so "log out everywhere" is possible. */
  private userFamiliesKey(userId: string): string {
    return `rt:families:${userId}`;
  }

  async startFamily(
    userId: string,
    familyId: string,
    jti: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.valkey
      .multi()
      .set(this.familyKey(userId, familyId), jti, 'EX', ttlSeconds)
      .sadd(this.userFamiliesKey(userId), familyId)
      .expire(this.userFamiliesKey(userId), ttlSeconds)
      .exec();
  }

  /**
   * Atomically swap the live jti, but ONLY if the presented one is current.
   *
   * This is a Lua script rather than GET-then-SET because two concurrent refreshes
   * with the same token must not both succeed. Read-compare-write in application
   * code has a race window; inside Lua, Valkey runs it atomically. That race is
   * not theoretical — a double-clicked login page will hit it.
   *
   * Returns 'rotated' | 'reuse' | 'unknown'.
   */
  async rotate(
    userId: string,
    familyId: string,
    presentedJti: string,
    nextJti: string,
    ttlSeconds: number,
  ): Promise<'rotated' | 'reuse' | 'unknown'> {
    const script = `
      local current = redis.call('GET', KEYS[1])
      if current == false then
        return 'unknown'
      end
      if current ~= ARGV[1] then
        return 'reuse'
      end
      redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
      return 'rotated'
    `;

    const result = (await this.valkey.eval(
      script,
      1,
      this.familyKey(userId, familyId),
      presentedJti,
      nextJti,
      String(ttlSeconds),
    )) as string;

    // A spent token means the family is compromised (or the client is broken).
    // Either way the safe move is to revoke everything descended from that login.
    if (result === 'reuse') {
      await this.revokeFamily(userId, familyId);
    }

    return result as 'rotated' | 'reuse' | 'unknown';
  }

  /** Log out this session. */
  async revokeFamily(userId: string, familyId: string): Promise<void> {
    await this.valkey
      .multi()
      .del(this.familyKey(userId, familyId))
      .srem(this.userFamiliesKey(userId), familyId)
      .exec();
  }

  /** Log out everywhere — password change, admin disable, suspected compromise. */
  async revokeAllForUser(userId: string): Promise<void> {
    const families = await this.valkey.smembers(this.userFamiliesKey(userId));
    if (families.length === 0) return;

    await this.valkey
      .multi()
      .del(...families.map((f) => this.familyKey(userId, f)))
      .del(this.userFamiliesKey(userId))
      .exec();
  }

  async isFamilyLive(userId: string, familyId: string): Promise<boolean> {
    return (await this.valkey.exists(this.familyKey(userId, familyId))) === 1;
  }
}
