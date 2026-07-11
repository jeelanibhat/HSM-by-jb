import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { BusinessDate } from '@hotelos/domain';
import type { UnitOfWork } from '../../../shared';

export class NoAvailabilityError extends Error {
  constructor(
    readonly roomTypeId: string,
    readonly date: string,
  ) {
    super(`No availability for that room type on ${date}.`);
    this.name = 'NoAvailabilityError';
  }
}

export interface AvailabilityRow {
  roomTypeId: string;
  date: string;
  total: number;
  sold: number;
  blocked: number;
  available: number;
}

/**
 * The availability engine (TDD §4.3).
 *
 *   available = total - sold - blocked,  per room type, per night
 *
 * A room type is bookable for [arrival, departure) iff available > 0 on EVERY
 * night. Counters live in `room_type_availability` and are moved inside the same
 * transaction as the reservation write — so the check is O(nights) rather than a
 * scan over every reservation ever taken, and two clerks racing for the last room
 * serialise on the row lock instead of both winning.
 */
@Injectable()
export class AvailabilityService {
  /**
   * Ensure a counter row exists for every night, refresh `total`/`blocked` from
   * live inventory, and LOCK the rows.
   *
   * The lock is the whole point. `SELECT ... FOR UPDATE` (via the INSERT ... ON
   * CONFLICT DO UPDATE, which takes a row lock) means a second transaction asking
   * about the same room-type/night blocks here until the first commits or rolls
   * back. Without it, two bookings both read sold=29 of 30, both decide there is
   * room, and both write sold=30 — one guest arrives to no room.
   *
   * `total` and `blocked` are recomputed from inventory on every call rather than
   * trusted from the row: a room taken OOO an hour ago must not still be counted
   * as sellable tonight.
   */
  private async ensureAndLock(
    u: UnitOfWork,
    roomTypeId: string,
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<void> {
    await u.tx.execute(sql`
      INSERT INTO reservations.room_type_availability
        (property_id, room_type_id, date, total, sold, blocked)
      SELECT
        ${u.propertyId}::uuid,
        ${roomTypeId}::uuid,
        d::date,
        (SELECT count(*) FROM inventory.rooms
          WHERE property_id = ${u.propertyId}::uuid AND room_type_id = ${roomTypeId}::uuid),
        0,
        (SELECT count(*) FROM inventory.rooms
          WHERE property_id = ${u.propertyId}::uuid AND room_type_id = ${roomTypeId}::uuid
            AND status IN ('OOO', 'OOS'))
      -- generate_series is end-INCLUSIVE, and the stay is half-open [arrival, departure),
      -- so we stop one day short: you are never charged for, and never occupy, the
      -- departure night.
      FROM generate_series(${from}::date, (${to}::date - 1), interval '1 day') d
      ON CONFLICT (property_id, room_type_id, date) DO UPDATE
        SET total   = EXCLUDED.total,
            blocked = EXCLUDED.blocked,
            updated_at = now()
    `);

    // Take the row locks explicitly and in a deterministic order (by date), so two
    // transactions touching overlapping ranges cannot deadlock by grabbing the
    // same rows in opposite orders.
    await u.tx.execute(sql`
      SELECT 1 FROM reservations.room_type_availability
      WHERE property_id = ${u.propertyId}::uuid
        AND room_type_id = ${roomTypeId}::uuid
        AND date >= ${from}::date AND date < ${to}::date
      ORDER BY date
      FOR UPDATE
    `);
  }

  /**
   * Move the `sold` counter by `delta` across [from, to), refusing to oversell.
   *
   * delta = +1 → booking a room     (must have availability on every night)
   * delta = -1 → releasing one      (cancellation, no-show, shortened stay)
   *
   * Throws NoAvailabilityError naming the first night that fails, so the UI can
   * say "we are full on the 14th" rather than "unavailable".
   */
  async adjustSold(
    u: UnitOfWork,
    roomTypeId: string,
    from: BusinessDate,
    to: BusinessDate,
    delta: number,
  ): Promise<void> {
    await this.ensureAndLock(u, roomTypeId, from, to);

    if (delta > 0) {
      const rows = (await u.tx.execute(sql`
        SELECT date::text AS date, total, sold, blocked
        FROM reservations.room_type_availability
        WHERE property_id = ${u.propertyId}::uuid
          AND room_type_id = ${roomTypeId}::uuid
          AND date >= ${from}::date AND date < ${to}::date
        ORDER BY date
      `)) as unknown as Array<{ date: string; total: number; sold: number; blocked: number }>;

      for (const r of rows) {
        if (r.total - r.sold - r.blocked < delta) {
          throw new NoAvailabilityError(roomTypeId, r.date);
        }
      }
    }

    // The DB CHECK (sold >= 0 AND sold <= total) is the backstop: if the guard
    // above were ever wrong, this write fails rather than silently overselling.
    await u.tx.execute(sql`
      UPDATE reservations.room_type_availability
      SET sold = sold + ${delta}, updated_at = now()
      WHERE property_id = ${u.propertyId}::uuid
        AND room_type_id = ${roomTypeId}::uuid
        AND date >= ${from}::date AND date < ${to}::date
    `);
  }

  /** Read-only availability grid, for the booking screen. */
  async query(
    u: UnitOfWork,
    from: BusinessDate,
    to: BusinessDate,
    roomTypeId?: string,
  ): Promise<AvailabilityRow[]> {
    /**
     * Computed live from inventory + the sold counter rather than read straight
     * out of the counter table, because a night nobody has booked yet has NO row —
     * and "no row" means "fully available", not "unavailable". Deriving it means a
     * missing row can never read as zero availability.
     */
    const rows = (await u.tx.execute(sql`
      WITH nights AS (
        SELECT d::date AS date FROM generate_series(${from}::date, ${to}::date, interval '1 day') d
      ),
      types AS (
        SELECT id, code FROM inventory.room_types
        WHERE property_id = ${u.propertyId}::uuid
          AND (${roomTypeId ?? null}::uuid IS NULL OR id = ${roomTypeId ?? null}::uuid)
      )
      SELECT
        t.id::text AS "roomTypeId",
        n.date::text AS date,
        (SELECT count(*)::int FROM inventory.rooms r
          WHERE r.property_id = ${u.propertyId}::uuid AND r.room_type_id = t.id) AS total,
        COALESCE(a.sold, 0)::int AS sold,
        (SELECT count(*)::int FROM inventory.rooms r
          WHERE r.property_id = ${u.propertyId}::uuid AND r.room_type_id = t.id
            AND r.status IN ('OOO','OOS')) AS blocked
      FROM types t
      CROSS JOIN nights n
      LEFT JOIN reservations.room_type_availability a
        ON a.property_id = ${u.propertyId}::uuid
       AND a.room_type_id = t.id
       AND a.date = n.date
      ORDER BY t.code, n.date
    `)) as unknown as Array<{
      roomTypeId: string;
      date: string;
      total: number;
      sold: number;
      blocked: number;
    }>;

    return rows.map((r) => ({
      ...r,
      available: Math.max(0, r.total - r.sold - r.blocked),
    }));
  }

  /** Is this room type bookable for the whole stay? */
  async isAvailable(
    u: UnitOfWork,
    roomTypeId: string,
    arrival: BusinessDate,
    departure: BusinessDate,
  ): Promise<boolean> {
    const rows = await this.query(u, arrival, departure, roomTypeId);

    // The departure night is not part of the stay — drop it before checking.
    return rows.filter((r) => r.date < departure).every((r) => r.available > 0);
  }
}
