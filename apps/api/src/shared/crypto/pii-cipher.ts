import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Env } from '../../config/env';

/**
 * Column-level encryption for guest PII (TDD §9: "Guest PII: encrypted at rest
 * (column-level for id_number)").
 *
 * WHY IN THE APPLICATION AND NOT pgcrypto.
 *
 * The obvious route is `pgp_sym_encrypt(id_number, 'key')` in SQL. Do not. The key
 * has to travel as a literal in the statement, which means it lands in
 * pg_stat_statements, in `log_min_duration_statement` slow-query logs, and in any
 * query the DBA happens to EXPLAIN. You end up with the encryption key sitting in
 * plaintext next to the ciphertext, in files that get shipped to log aggregators.
 * The database would be encrypted against everything except the one attacker who
 * has the database.
 *
 * Encrypting here means Postgres only ever sees ciphertext. A leaked dump, a stolen
 * replica, a misconfigured backup bucket — none of them yield a single ID number.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather than
 * quietly returning garbage that we then show to a receptionist.
 */
@Injectable()
export class PiiCipher {
  private readonly key: Buffer;
  private readonly hashKey: Buffer;

  /** Version tag, so a future key rotation or algorithm change is migratable. */
  private static readonly VERSION = 'v1';

  constructor(config: ConfigService<Env, true>) {
    const encKey: string = config.get('PII_ENCRYPTION_KEY', { infer: true });
    const hashKey: string = config.get('PII_HASH_KEY', { infer: true });

    this.key = Buffer.from(encKey, 'base64');
    this.hashKey = Buffer.from(hashKey, 'base64');

    if (this.key.length !== 32) {
      throw new Error('PII_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).');
    }
    if (this.hashKey.length < 32) {
      throw new Error('PII_HASH_KEY must decode to at least 32 bytes.');
    }
  }

  /**
   * Encrypt. A fresh random IV per call, so encrypting the same passport number
   * twice yields different ciphertext — otherwise the column itself would leak
   * "these two guests share an ID" to anyone who can read it.
   */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12); // 96-bit, the GCM standard
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      PiiCipher.VERSION,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  decrypt(encoded: string): string {
    const [version, ivB64, tagB64, dataB64] = encoded.split(':');

    if (version !== PiiCipher.VERSION || !ivB64 || !tagB64 || !dataB64) {
      throw new Error('Malformed PII ciphertext.');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

    // Throws if the tag does not verify — tampering fails loudly.
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /**
   * Blind index: a keyed, deterministic hash used ONLY to look a guest up by their
   * ID number without decrypting the whole table.
   *
   * HMAC, not a plain SHA-256. A bare hash of a passport number is trivially
   * reversible — the search space is small and structured, so a rainbow table over
   * every plausible number cracks the column in minutes. The secret key is what
   * makes that attack require the key too.
   *
   * It is still deterministic, which is the trade: identical ID numbers produce
   * identical hashes, so the index reveals that two rows share an ID. That is the
   * price of being able to search at all, and it is a far smaller leak than
   * storing the number.
   */
  blindIndex(plaintext: string): string {
    return createHmac('sha256', this.hashKey)
      .update(plaintext.trim().toUpperCase()) // normalise: 'ab123' and 'AB123 ' are one person
      .digest('base64');
  }

  /** Constant-time compare, so a lookup cannot be turned into a timing oracle. */
  matches(plaintext: string, storedHash: string): boolean {
    const computed = Buffer.from(this.blindIndex(plaintext));
    const stored = Buffer.from(storedHash);

    if (computed.length !== stored.length) return false;
    return timingSafeEqual(computed, stored);
  }

  /**
   * What a receptionist sees by default: 'P1234567' → '••••4567'.
   *
   * The full number is available only through an explicitly audited reveal. Most of
   * the time nobody needs it, and a screen that displays it by default is a screen
   * that gets photographed.
   */
  mask(plaintext: string): string {
    const trimmed = plaintext.trim();
    if (trimmed.length <= 4) return '••••';
    return '••••' + trimmed.slice(-4);
  }
}
