import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id — the current password-hashing recommendation (OWASP), and memory-hard,
 * which is what makes GPU cracking expensive. bcrypt is not memory-hard.
 */
@Injectable()
export class PasswordService {
  /** OWASP minimums for argon2id: 19 MiB, 2 iterations, parallelism 1. */
  private readonly options: argon2.Options = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  };

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed hash in the DB must read as "wrong password", never as a 500
      // that tells an attacker this account exists but is broken.
      return false;
    }
  }

  /**
   * Burn roughly the same CPU as a real verify, for logins against an email that
   * doesn't exist. Without this, "no such user" returns in ~1ms and a real user
   * with a wrong password takes ~50ms — a timing oracle that enumerates accounts.
   */
  async fakeVerify(): Promise<void> {
    await argon2.hash('timing-equalisation-dummy-password', this.options);
  }
}
