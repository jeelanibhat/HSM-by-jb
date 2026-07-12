import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TenantTransaction } from '../../../db/tenant-transaction';

export interface FrontDeskRow {
  reservationId: string;
  reservationRoomId: string;
  confirmationNo: string;
  guestId: string;
  guestName: string;
  vip: boolean;
  status: string;
  roomId: string | null;
  roomNumber: string | null;
  roomTypeId: string;
  roomTypeCode: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  folioId: string | null;
  /** What the guest owes right now. Check-out is refused unless this is zero. */
  balanceMinor: number;
}

export interface FrontDeskBoard {
  businessDate: string;
  arrivals: FrontDeskRow[];
  departures: FrontDeskRow[];
  inHouse: FrontDeskRow[];
}

/**
 * The front desk board (TDD §5.2 — arrivals, departures).
 *
 * One query per list, each joining guest, room and folio balance. The obvious shape
 * — fetch reservations, then each guest, then each room, then each folio — is the
 * N+1 that makes a busy morning feel broken. This is the screen a receptionist has
 * open all day.
 *
 * The balance comes from the same SUM the folio uses, so the number on the list and
 * the number on the bill cannot disagree.
 */
@Injectable()
export class FrontDeskService {
  constructor(private readonly tx: TenantTransaction) {}

  async board(propertyId: string, date: string): Promise<FrontDeskBoard> {
    return this.tx.run(propertyId, async (tx) => {
      const base = (where: ReturnType<typeof sql>) => sql`
        SELECT
          r.id::text                AS "reservationId",
          rr.id::text               AS "reservationRoomId",
          r.confirmation_no         AS "confirmationNo",
          g.id::text                AS "guestId",
          (g.first_name || ' ' || g.last_name) AS "guestName",
          g.vip                     AS "vip",
          r.status                  AS "status",
          rr.room_id::text          AS "roomId",
          rm.number                 AS "roomNumber",
          rt.id::text               AS "roomTypeId",
          rt.code                   AS "roomTypeCode",
          rr.arrival_date::text     AS "arrivalDate",
          rr.departure_date::text   AS "departureDate",
          rr.adults                 AS "adults",
          rr.children               AS "children",
          f.id::text                AS "folioId",
          COALESCE((
            SELECT SUM(l.amount_minor)::int
            FROM folio.folio_lines l
            WHERE l.folio_id = f.id
          ), 0)                     AS "balanceMinor"
        FROM reservations.reservation_rooms rr
        JOIN reservations.reservations r ON r.id = rr.reservation_id
        JOIN guests.guests g             ON g.id = r.guest_id
        JOIN inventory.room_types rt     ON rt.id = rr.room_type_id
        LEFT JOIN inventory.rooms rm     ON rm.id = rr.room_id
        LEFT JOIN folio.folios f         ON f.reservation_id = r.id
        WHERE ${where}
        ORDER BY g.vip DESC, rm.number NULLS LAST, r.confirmation_no
      `;

      // Due to arrive today and not yet checked in.
      const arrivals = (await tx.execute(
        base(sql`rr.arrival_date = ${date}::date AND rr.status = 'CONFIRMED'`),
      )) as unknown as FrontDeskRow[];

      // In-house and due to leave today.
      const departures = (await tx.execute(
        base(sql`rr.departure_date = ${date}::date AND rr.status = 'CHECKED_IN'`),
      )) as unknown as FrontDeskRow[];

      // Everyone currently in the building — the stay is half-open, so a guest
      // departing today is still in-house until they check out.
      const inHouse = (await tx.execute(
        base(sql`rr.status = 'CHECKED_IN'`),
      )) as unknown as FrontDeskRow[];

      return { businessDate: date, arrivals, departures, inHouse };
    });
  }
}
