import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { TenantTransaction } from '../../../db/tenant-transaction';
import type { UnitOfWork } from '../../../shared';
import { properties } from '../../property/infra/schema';
import { dailyStats } from '../infra/schema';

export interface DailySnapshot {
  roomsAvailable: number;
  roomsSold: number;
  roomsOutOfOrder: number;
  occupancyBps: number;
  roomRevenueMinor: number;
  otherRevenueMinor: number;
  taxMinor: number;
  adrMinor: number;
  revparMinor: number;
}

export interface RevenueLine {
  code: string;
  count: number;
  amountMinor: number;
}

/**
 * The daily revenue report (TDD §5.2) — what the trading day actually produced,
 * and whether the books balance.
 */
export interface DailyRevenueReport {
  businessDate: string;
  currency: string;

  /** Revenue by code — ROOM, F&B, LAUNDRY. NET of tax. */
  revenue: RevenueLine[];
  /** Payments taken, by method — CASH, CARD, UPI. Reported POSITIVE. */
  payments: RevenueLine[];
  /** Reversals and corrections posted today. */
  adjustments: RevenueLine[];

  roomRevenueMinor: number;
  otherRevenueMinor: number;
  taxMinor: number;
  /** Everything the guest was billed today, tax included. */
  grossRevenueMinor: number;

  paymentsMinor: number;
  adjustmentsMinor: number;

  /**
   * TRIAL BALANCE (TDD §6 step 5).
   *
   *   posted today − settled today = movement in what guests owe
   *
   * `outstandingMinor` is the total balance of every OPEN folio right now — money
   * guests in the building still owe. If that number and the ledger disagree, the
   * books do not balance and somebody has posted something the report cannot see.
   */
  outstandingMinor: number;
  openFolios: number;

  /** Occupancy figures, frozen by the night audit. Null until it has run. */
  snapshot: DailySnapshot | null;
}

@Injectable()
export class ReportingService {
  constructor(private readonly tx: TenantTransaction) {}

  // ── Written by night-audit, through the module facade ─────────────────────

  /**
   * Freeze tonight's numbers. Idempotent: a re-run of the audit overwrites the row
   * with the same values rather than creating a second, contradictory snapshot.
   */
  async snapshotDaily(
    u: UnitOfWork,
    businessDate: string,
    stats: DailySnapshot,
  ): Promise<void> {
    await u.tx
      .insert(dailyStats)
      .values({ propertyId: u.propertyId, businessDate, ...stats })
      .onConflictDoUpdate({
        target: [dailyStats.propertyId, dailyStats.businessDate],
        set: { ...stats },
      });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** Occupancy / ADR / RevPAR across a range (TDD §5.2). */
  async occupancyReport(propertyId: string, from: string, to: string) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select()
        .from(dailyStats)
        .where(
          and(
            sql`${dailyStats.businessDate} >= ${from}::date`,
            sql`${dailyStats.businessDate} <= ${to}::date`,
          ),
        )
        .orderBy(dailyStats.businessDate),
    );
  }

  /**
   * The daily revenue report.
   *
   * Keyed on BUSINESS date, not on `created_at` (TDD §6). A charge keyed in at 01:00
   * belongs to the trading day that has not yet closed — reporting it against the
   * calendar date would move revenue between days and make the figures disagree with
   * the night audit's own snapshot.
   */
  async dailyRevenue(propertyId: string, businessDate: string): Promise<DailyRevenueReport> {
    return this.tx.run(propertyId, async (tx) => {
      const [property] = await tx
        .select()
        .from(properties)
        .where(eq(properties.id, propertyId))
        .limit(1);

      const currency = property?.currency ?? 'INR';

      /**
       * One pass over the day's ledger, grouped. The report is read every morning by
       * a manager and every month by an accountant — it must not be a query per code.
       */
      const rows = (await tx.execute(sql`
        SELECT
          type,
          code,
          count(*)::int          AS count,
          SUM(amount_minor)::bigint AS amount
        FROM folio.folio_lines
        WHERE property_id = ${propertyId}::uuid
          AND business_date = ${businessDate}::date
        GROUP BY type, code
        ORDER BY type, code
      `)) as unknown as Array<{
        type: string;
        code: string;
        count: number;
        amount: string | number;
      }>;

      const revenue: RevenueLine[] = [];
      const payments: RevenueLine[] = [];
      const adjustments: RevenueLine[] = [];

      let roomRevenue = 0;
      let otherRevenue = 0;
      let tax = 0;
      let paymentsTotal = 0;
      let adjustmentsTotal = 0;

      for (const r of rows) {
        const amount = Number(r.amount);
        const line: RevenueLine = { code: r.code, count: r.count, amountMinor: amount };

        switch (r.type) {
          case 'CHARGE':
            revenue.push(line);
            if (r.code === 'ROOM') roomRevenue += amount;
            else otherRevenue += amount;
            break;

          case 'TAX':
            tax += amount;
            break;

          case 'PAYMENT':
            // Stored negative (a payment reduces what the guest owes). A report that
            // showed "cash: -45,000" would be read as a refund by everyone who saw it.
            payments.push({ ...line, amountMinor: -amount });
            paymentsTotal += -amount;
            break;

          case 'ADJUSTMENT':
            adjustments.push(line);
            adjustmentsTotal += amount;
            break;
        }
      }

      /**
       * The trial balance (TDD §6 step 5). What guests in the building still owe,
       * right now. If this and the ledger disagree, something has been posted that
       * the report cannot see, and the books do not balance.
       */
      const outstanding = (await tx.execute(sql`
        SELECT
          COALESCE(SUM(l.amount_minor), 0)::bigint AS balance,
          count(DISTINCT f.id)::int               AS folios
        FROM folio.folios f
        JOIN folio.folio_lines l ON l.folio_id = f.id
        WHERE f.property_id = ${propertyId}::uuid
          AND f.status = 'OPEN'
      `)) as unknown as Array<{ balance: string | number; folios: number }>;

      const [snapshot] = await tx
        .select()
        .from(dailyStats)
        .where(eq(dailyStats.businessDate, businessDate))
        .limit(1);

      return {
        businessDate,
        currency,
        revenue,
        payments,
        adjustments,
        roomRevenueMinor: roomRevenue,
        otherRevenueMinor: otherRevenue,
        taxMinor: tax,
        // What guests were actually billed — net revenue plus the tax on it, plus
        // any corrections posted today.
        grossRevenueMinor: roomRevenue + otherRevenue + tax + adjustmentsTotal,
        paymentsMinor: paymentsTotal,
        adjustmentsMinor: adjustmentsTotal,
        outstandingMinor: Number(outstanding[0]?.balance ?? 0),
        openFolios: outstanding[0]?.folios ?? 0,
        snapshot: snapshot
          ? {
              roomsAvailable: snapshot.roomsAvailable,
              roomsSold: snapshot.roomsSold,
              roomsOutOfOrder: snapshot.roomsOutOfOrder,
              occupancyBps: snapshot.occupancyBps,
              roomRevenueMinor: snapshot.roomRevenueMinor,
              otherRevenueMinor: snapshot.otherRevenueMinor,
              taxMinor: snapshot.taxMinor,
              adrMinor: snapshot.adrMinor,
              revparMinor: snapshot.revparMinor,
            }
          : null,
      };
    });
  }
}
