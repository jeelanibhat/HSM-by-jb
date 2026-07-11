import { Injectable } from '@nestjs/common';
import { businessDate, eachDateInclusive } from '@hotelos/domain';
import { sql } from 'drizzle-orm';
import { TenantTransaction } from '../../../db/tenant-transaction';

export interface TapeChartRoom {
  id: string;
  number: string;
  floor: string | null;
  status: string;
  roomTypeId: string;
  roomTypeCode: string;
}

export interface TapeChartBlock {
  reservationRoomId: string;
  reservationId: string;
  roomId: string;
  confirmationNo: string;
  guestName: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
}

/** A booking with no physical room yet — it still consumes inventory. */
export interface UnassignedBlock {
  reservationRoomId: string;
  reservationId: string;
  confirmationNo: string;
  guestName: string;
  status: string;
  roomTypeId: string;
  roomTypeCode: string;
  arrivalDate: string;
  departureDate: string;
}

export interface TapeChart {
  from: string;
  to: string;
  dates: string[];
  rooms: TapeChartRoom[];
  blocks: TapeChartBlock[];
  unassigned: UnassignedBlock[];
}

@Injectable()
export class TapeChartService {
  constructor(private readonly tx: TenantTransaction) {}

  /**
   * The whole grid in TWO queries — rooms, and the blocks overlapping the window
   * (TDD §5.3: "tapeChart is one hand-written SQL query returning the full grid,
   * not nested resolvers").
   *
   * The naive shape — resolve rooms, then resolve each room's reservations, then
   * each reservation's guest — is 1 + 500 + 500 queries for a 500-room hotel. The
   * chart is the screen the front desk stares at all day; it cannot be an N+1.
   *
   * Overlap is `stay && daterange(from, to+1)`, which uses the same GiST index the
   * exclusion constraint is built on, so the window scan is cheap.
   */
  async get(propertyId: string, from: string, to: string): Promise<TapeChart> {
    const start = businessDate(from);
    const end = businessDate(to);

    return this.tx.run(propertyId, async (tx) => {
      const rooms = (await tx.execute(sql`
        SELECT
          r.id::text            AS "id",
          r.number              AS "number",
          r.floor               AS "floor",
          r.status              AS "status",
          rt.id::text           AS "roomTypeId",
          rt.code               AS "roomTypeCode"
        FROM inventory.rooms r
        JOIN inventory.room_types rt ON rt.id = r.room_type_id
        ORDER BY r.floor NULLS LAST, r.number
      `)) as unknown as TapeChartRoom[];

      /**
       * Blocks: assigned rooms whose stay overlaps the window.
       *
       * CANCELLED and NO_SHOW are excluded — they no longer hold the room, and
       * drawing them would show the chart as full when it is not. Same predicate
       * as the exclusion constraint's WHERE clause; they must agree.
       */
      const blocks = (await tx.execute(sql`
        SELECT
          rr.id::text           AS "reservationRoomId",
          rr.reservation_id::text AS "reservationId",
          rr.room_id::text      AS "roomId",
          res.confirmation_no   AS "confirmationNo",
          (g.first_name || ' ' || g.last_name) AS "guestName",
          rr.status             AS "status",
          rr.arrival_date::text   AS "arrivalDate",
          rr.departure_date::text AS "departureDate"
        FROM reservations.reservation_rooms rr
        JOIN reservations.reservations res ON res.id = rr.reservation_id
        JOIN guests.guests g ON g.id = res.guest_id
        WHERE rr.room_id IS NOT NULL
          AND rr.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND rr.stay && daterange(${start}::date, (${end}::date + 1), '[)')
        ORDER BY rr.arrival_date
      `)) as unknown as TapeChartBlock[];

      // Bookings with no room yet. They are the front desk's work list for the
      // day — invisible on the grid itself, so they get their own tray.
      const unassigned = (await tx.execute(sql`
        SELECT
          rr.id::text             AS "reservationRoomId",
          rr.reservation_id::text AS "reservationId",
          res.confirmation_no     AS "confirmationNo",
          (g.first_name || ' ' || g.last_name) AS "guestName",
          rr.status               AS "status",
          rt.id::text             AS "roomTypeId",
          rt.code                 AS "roomTypeCode",
          rr.arrival_date::text   AS "arrivalDate",
          rr.departure_date::text AS "departureDate"
        FROM reservations.reservation_rooms rr
        JOIN reservations.reservations res ON res.id = rr.reservation_id
        JOIN guests.guests g ON g.id = res.guest_id
        JOIN inventory.room_types rt ON rt.id = rr.room_type_id
        WHERE rr.room_id IS NULL
          AND rr.status NOT IN ('CANCELLED', 'NO_SHOW')
          AND rr.stay && daterange(${start}::date, (${end}::date + 1), '[)')
        ORDER BY rr.arrival_date
      `)) as unknown as UnassignedBlock[];

      return {
        from: start,
        to: end,
        dates: eachDateInclusive(start, end),
        rooms,
        blocks,
        unassigned,
      };
    });
  }
}
