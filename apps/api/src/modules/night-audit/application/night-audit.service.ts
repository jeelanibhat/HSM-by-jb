import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  add,
  businessDate,
  money,
  nextDay,
  taxFromBps,
  zero,
  type BusinessDate,
} from '@hotelos/domain';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { nightAuditRuns } from '../../../db/schema/shared';
import { TransactionalUnitOfWork, type ActorContext, type UnitOfWork } from '../../../shared';
import { folioLines, folios } from '../../folio/infra/schema';
import { ratePrices, rooms } from '../../inventory/infra/schema';
import { properties, taxes } from '../../property/infra/schema';
import { reservationRooms, reservations } from '../../reservations/infra/schema';
// Through the facade, not the table. The frozen snapshot has one author.
import { ReportingService } from '../../reporting';
// Likewise: the board has one author, and it is not the night audit.
import { HousekeepingService } from '../../housekeeping';

/**
 * The night audit sequence (TDD §6), in order. Each step is idempotent and each
 * runs in its own transaction, so a failure part-way through leaves the completed
 * steps committed and the run resumable from where it stopped.
 *
 * A single giant transaction would be simpler to write and much worse to operate:
 * a failure at step 5 of 5 would roll back four steps' work, and the operator would
 * have to re-run everything at 3am with no idea which parts had already been right.
 */
export const AUDIT_STEPS = [
  'POST_ROOM_CHARGES',
  'MARK_NO_SHOWS',
  'SNAPSHOT_STATS',
  'ADVANCE_BUSINESS_DATE',

  /**
   * LAST, and after the date has moved — on purpose.
   *
   * The board it builds is for the day that has just BEGUN: the guests leaving this
   * morning, the guests staying on, and the rooms already standing empty. Generating
   * it before the date advanced would build yesterday's board a second time.
   *
   * It is also the only step that may be skipped without consequence — a hotel with
   * no housekeeping staff on the system still wants its charges posted and its books
   * closed — so it runs last, where a failure costs nothing that came before it.
   */
  'GENERATE_HOUSEKEEPING_BOARD',
] as const;

export type AuditStep = (typeof AUDIT_STEPS)[number];

export interface StepResult {
  step: AuditStep;
  status: 'COMPLETED' | 'SKIPPED' | 'FAILED';
  detail?: string;
  at: string;
}

export interface NightAuditResult {
  runId: string;
  businessDate: string;
  newBusinessDate: string | null;
  status: 'COMPLETED' | 'FAILED';
  steps: StepResult[];
}

@Injectable()
export class NightAuditService {
  private readonly logger = new Logger(NightAuditService.name);

  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly tx: TenantTransaction,
    private readonly reporting: ReportingService,
    private readonly housekeeping: HousekeepingService,
  ) {}

  /**
   * Run (or resume) the night audit for the property's CURRENT business date.
   *
   * Idempotent at every level:
   *   - the run row is unique per (property, business date)
   *   - each step checks whether its work is already done
   *   - room charges are additionally protected by a unique index, so even a
   *     concurrent double-run cannot charge a guest twice for the same night
   */
  async run(actor: ActorContext): Promise<NightAuditResult> {
    const property = await this.loadProperty(actor.propertyId);
    const auditDate = businessDate(property.businessDate);

    const run = await this.startOrResume(actor, auditDate);
    const completed = new Set(
      (run.steps as StepResult[])
        .filter((s) => s.status === 'COMPLETED' || s.status === 'SKIPPED')
        .map((s) => s.step),
    );

    const results: StepResult[] = [...(run.steps as StepResult[])];

    for (const step of AUDIT_STEPS) {
      if (completed.has(step)) {
        this.logger.log(`Night audit ${auditDate}: ${step} already done, skipping.`);
        continue;
      }

      try {
        const detail = await this.executeStep(actor, step, auditDate);

        results.push({ step, status: 'COMPLETED', detail, at: new Date().toISOString() });
        await this.recordSteps(actor, run.id, results, 'RUNNING');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        results.push({ step, status: 'FAILED', detail: message, at: new Date().toISOString() });
        await this.recordSteps(actor, run.id, results, 'FAILED');

        this.logger.error(`Night audit ${auditDate} failed at ${step}: ${message}`);

        // Everything before this step stays committed. Fix the cause, run it again,
        // and it picks up exactly here.
        throw new BadRequestException(`Night audit failed at ${step}: ${message}`);
      }
    }

    await this.recordSteps(actor, run.id, results, 'COMPLETED');

    const after = await this.loadProperty(actor.propertyId);

    await this.uow.execute(actor, async (u) => {
      u.emit({
        aggregateType: 'property',
        aggregateId: actor.propertyId,
        eventType: 'night_audit.completed',
        payload: { businessDate: auditDate, newBusinessDate: after.businessDate },
      });
    });

    return {
      runId: run.id,
      businessDate: auditDate,
      newBusinessDate: after.businessDate,
      status: 'COMPLETED',
      steps: results,
    };
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  private async executeStep(
    actor: ActorContext,
    step: AuditStep,
    auditDate: BusinessDate,
  ): Promise<string> {
    switch (step) {
      case 'POST_ROOM_CHARGES':
        return this.postRoomCharges(actor, auditDate);
      case 'MARK_NO_SHOWS':
        return this.markNoShows(actor, auditDate);
      case 'SNAPSHOT_STATS':
        return this.snapshotStats(actor, auditDate);
      case 'ADVANCE_BUSINESS_DATE':
        return this.advanceBusinessDate(actor, auditDate);
      case 'GENERATE_HOUSEKEEPING_BOARD':
        return this.generateHousekeepingBoard(actor, auditDate);
    }
  }

  /**
   * Step 5 — build the morning's housekeeping board, for the day that has just begun.
   *
   * The supervisor arrives to a board that is already there, instead of remembering to
   * press a button before anyone can be given a room to clean.
   *
   * `generateBoard` is idempotent (UNIQUE(room, date, type)), so this is safe to
   * re-run after a crash and safe for a supervisor to press again afterwards — the
   * second call creates nothing and resets nothing already underway.
   */
  private async generateHousekeepingBoard(
    actor: ActorContext,
    auditDate: BusinessDate,
  ): Promise<string> {
    // The date has already moved: this is the NEW trading day, not the one just closed.
    const today = nextDay(auditDate);

    const { created } = await this.housekeeping.generateBoard(actor, today);

    return created === 0
      ? `No housekeeping raised for ${today} — the board was already up to date.`
      : `Raised ${created} housekeeping task(s) for ${today}.`;
  }

  /**
   * Step 1 — post room and tax charges for every in-house room, for tonight.
   *
   * The rate comes from the daily grid for THIS date, not from the reservation. A
   * hotel that raised its rates mid-stay charges the new rate for the new nights,
   * which is what the rate grid is for.
   *
   * If a night has no price, the step FAILS and names the room types. Posting an
   * unknown rate would be inventing a number and putting it on a guest's bill;
   * posting zero would give the room away. Failing is the honest option, and the
   * run resumes here once someone prices the night.
   */
  private async postRoomCharges(actor: ActorContext, auditDate: BusinessDate): Promise<string> {
    return this.uow.execute(actor, async (u) => {
      const inHouse = await u.tx
        .select({
          reservationRoomId: reservationRooms.id,
          reservationId: reservationRooms.reservationId,
          roomTypeId: reservationRooms.roomTypeId,
          ratePlanId: reservationRooms.ratePlanId,
          roomId: reservationRooms.roomId,
          departureDate: reservationRooms.departureDate,
        })
        .from(reservationRooms)
        .where(eq(reservationRooms.status, 'CHECKED_IN'));

      /**
       * A guest departing THIS MORNING is not charged for tonight — the stay is
       * half-open [arrival, departure). Charging the departure night is the single
       * most common PMS billing complaint, and it is this line that prevents it.
       */
      const staying = inHouse.filter((r) => r.departureDate > auditDate);

      if (staying.length === 0) {
        return 'No in-house rooms to charge.';
      }

      const property = await this.loadPropertyTx(u);
      const taxRows = await u.tx.select().from(taxes).where(eq(taxes.propertyId, u.propertyId));

      const missing: string[] = [];
      let posted = 0;
      let total = zero(property.currency);

      for (const line of staying) {
        const [price] = await u.tx
          .select()
          .from(ratePrices)
          .where(
            and(
              eq(ratePrices.ratePlanId, line.ratePlanId),
              eq(ratePrices.roomTypeId, line.roomTypeId),
              eq(ratePrices.date, auditDate),
            ),
          )
          .limit(1);

        if (!price) {
          missing.push(line.roomTypeId);
          continue;
        }

        const [folio] = await u.tx
          .select()
          .from(folios)
          .where(eq(folios.reservationId, line.reservationId))
          .limit(1);

        if (!folio) continue; // no folio means not really checked in

        const gross = money(price.priceMinor, property.currency);
        const chargeId = uuidv7();

        /**
         * The unique index folio_lines_one_room_charge_per_night makes this INSERT
         * fail if a room charge already exists for this reservation-room on this
         * business date. onConflictDoNothing turns that into a no-op.
         *
         * This is what makes a double-run of the night audit physically incapable of
         * charging a guest twice for the same night. The application checks too, but
         * the application is not what an operator re-running the audit at 3am is
         * relying on.
         */
        const inserted = await u.tx
          .insert(folioLines)
          .values({
            id: chargeId,
            propertyId: u.propertyId,
            folioId: folio.id,
            businessDate: auditDate,
            type: 'CHARGE',
            code: 'ROOM',
            description: `Room charge · ${auditDate}`,
            amountMinor: gross.minor,
            currency: property.currency,
            taxAmountMinor: 0,
            sourceModule: 'night-audit',
            reservationRoomId: line.reservationRoomId,
            postedBy: actor.userId,
          })
          .onConflictDoNothing()
          .returning();

        if (inserted.length === 0) continue; // already charged for this night

        posted += 1;
        total = add(total, gross);

        for (const t of taxRows) {
          const mode = t.type === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';
          const taxAmount = taxFromBps(gross, t.rateBps, mode);

          await u.tx.insert(folioLines).values({
            id: uuidv7(),
            propertyId: u.propertyId,
            folioId: folio.id,
            businessDate: auditDate,
            type: 'TAX',
            code: 'TAX',
            description: t.name,
            amountMinor: taxAmount.minor,
            currency: property.currency,
            taxAmountMinor: taxAmount.minor,
            parentLineId: chargeId,
            sourceModule: 'night-audit',
            postedBy: actor.userId,
          });
        }

        // INCLUSIVE tax is carved out of the quoted rate — the charge line drops to
        // the net, exactly as it does in FolioService.
        if (taxRows.some((t) => t.type === 'INCLUSIVE')) {
          const inclusiveTax = taxRows
            .filter((t) => t.type === 'INCLUSIVE')
            .reduce(
              (acc, t) => add(acc, taxFromBps(gross, t.rateBps, 'INCLUSIVE')),
              zero(property.currency),
            );

          // The charge line was inserted at gross; correct it to net BEFORE anything
          // reads it. It is still within this transaction and this line has not been
          // seen by anyone — this is not an edit to posted history.
          await u.tx.execute(sql`
            UPDATE folio.folio_lines
            SET amount_minor = ${gross.minor - inclusiveTax.minor}
            WHERE id = ${chargeId}
          `);
        }
      }

      if (missing.length > 0) {
        const unique = [...new Set(missing)];
        throw new Error(
          `No rate is loaded for ${auditDate} on ${unique.length} room type(s). ` +
            `Price the night, then run the audit again — it will resume from here.`,
        );
      }

      u.audit({
        action: 'night_audit.room_charges_posted',
        entityType: 'property',
        entityId: u.propertyId,
        after: { businessDate: auditDate, rooms: posted, totalMinor: total.minor },
      });

      return `Posted ${posted} room charge(s) totalling ${total.minor} minor units.`;
    });
  }

  /**
   * Step 2 — a confirmed guest who never arrived is a no-show.
   *
   * This RELEASES the inventory they were holding: a no-show that keeps its room
   * would quietly shrink the hotel by one room a night, forever.
   */
  private async markNoShows(actor: ActorContext, auditDate: BusinessDate): Promise<string> {
    return this.uow.execute(actor, async (u) => {
      const stragglers = await u.tx
        .select()
        .from(reservations)
        .where(
          and(
            eq(reservations.status, 'CONFIRMED'),
            // Arrival date has come (or passed) and they never checked in.
            lt(reservations.arrivalDate, nextDay(auditDate)),
          ),
        );

      if (stragglers.length === 0) return 'No no-shows.';

      const ids = stragglers.map((r) => r.id);

      const heldRooms = await u.tx
        .select()
        .from(reservationRooms)
        .where(inArray(reservationRooms.reservationId, ids));

      // Give the inventory back, night by night.
      for (const line of heldRooms) {
        await u.tx.execute(sql`
          UPDATE reservations.room_type_availability
          SET sold = sold - 1, updated_at = now()
          WHERE property_id = ${u.propertyId}::uuid
            AND room_type_id = ${line.roomTypeId}::uuid
            AND date >= ${line.arrivalDate}::date
            AND date <  ${line.departureDate}::date
            AND sold > 0
        `);
      }

      await u.tx
        .update(reservationRooms)
        .set({ status: 'NO_SHOW', updatedAt: new Date() })
        .where(inArray(reservationRooms.reservationId, ids));

      await u.tx
        .update(reservations)
        .set({ status: 'NO_SHOW', updatedAt: new Date() })
        .where(inArray(reservations.id, ids));

      for (const r of stragglers) {
        u.audit({
          action: 'reservation.no_show',
          entityType: 'reservation',
          entityId: r.id,
          before: { status: 'CONFIRMED' },
          after: { status: 'NO_SHOW' },
          reason: `Did not arrive by close of business on ${auditDate}`,
        });

        u.emit({
          aggregateType: 'reservation',
          aggregateId: r.id,
          eventType: 'reservation.no_show',
          payload: { confirmationNo: r.confirmationNo, businessDate: auditDate },
        });
      }

      return `Marked ${stragglers.length} reservation(s) as no-show.`;
    });
  }

  /**
   * Step 3 — freeze tonight's numbers (TDD §6 step 4).
   *
   * Occupancy, ADR and RevPAR are computed ONCE and stored. They are not a view over
   * live data: a cancellation next week must not retroactively change what last
   * Tuesday's occupancy was. That number has been reported to an owner.
   */
  private async snapshotStats(actor: ActorContext, auditDate: BusinessDate): Promise<string> {
    return this.uow.execute(actor, async (u) => {
      const allRooms = await u.tx.select().from(rooms);
      const outOfOrder = allRooms.filter((r) => r.status === 'OOO' || r.status === 'OOS').length;
      const available = allRooms.length - outOfOrder;

      // Rooms actually occupied tonight.
      const sold = (
        await u.tx
          .select({ n: sql<number>`count(*)::int` })
          .from(reservationRooms)
          .where(
            and(
              eq(reservationRooms.status, 'CHECKED_IN'),
              sql`${reservationRooms.arrivalDate} <= ${auditDate}::date`,
              sql`${reservationRooms.departureDate} > ${auditDate}::date`,
            ),
          )
      )[0]!.n;

      // Revenue posted for THIS business date, net of tax.
      const revenue = (await u.tx.execute(sql`
        SELECT
          COALESCE(SUM(amount_minor) FILTER (WHERE type = 'CHARGE' AND code = 'ROOM'), 0)::bigint AS room,
          COALESCE(SUM(amount_minor) FILTER (WHERE type = 'CHARGE' AND code <> 'ROOM'), 0)::bigint AS other,
          COALESCE(SUM(amount_minor) FILTER (WHERE type = 'TAX'), 0)::bigint AS tax
        FROM folio.folio_lines
        WHERE property_id = ${u.propertyId}::uuid AND business_date = ${auditDate}::date
      `)) as unknown as Array<{ room: number; other: number; tax: number }>;

      const roomRevenue = Number(revenue[0]?.room ?? 0);
      const otherRevenue = Number(revenue[0]?.other ?? 0);
      const taxTotal = Number(revenue[0]?.tax ?? 0);

      /**
       * ADR divides by rooms SOLD; RevPAR by rooms AVAILABLE. Confusing the two is
       * the classic hotel-metrics error — ADR flatters a half-empty hotel, RevPAR
       * tells the truth. On a night with nothing sold, ADR is 0, not a divide-by-zero.
       */
      const adr = sold > 0 ? Math.round(roomRevenue / sold) : 0;
      const revpar = available > 0 ? Math.round(roomRevenue / available) : 0;
      const occupancyBps = available > 0 ? Math.round((sold / available) * 10_000) : 0;

      // Written through the reporting facade. Re-running the audit recomputes the
      // same numbers over the same row rather than creating a second, contradictory
      // snapshot for the same night.
      await this.reporting.snapshotDaily(u, auditDate, {
        roomsAvailable: available,
        roomsSold: sold,
        roomsOutOfOrder: outOfOrder,
        occupancyBps,
        roomRevenueMinor: roomRevenue,
        otherRevenueMinor: otherRevenue,
        taxMinor: taxTotal,
        adrMinor: adr,
        revparMinor: revpar,
      });

      u.audit({
        action: 'night_audit.stats_snapshot',
        entityType: 'property',
        entityId: u.propertyId,
        after: { businessDate: auditDate, sold, available, occupancyBps, adr, revpar },
      });

      return `${sold}/${available} sold · occupancy ${(occupancyBps / 100).toFixed(1)}% · ADR ${adr} · RevPAR ${revpar}`;
    });
  }

  /**
   * Step 4 — advance the business date. THE act that closes the trading day.
   *
   * Guarded: it only moves the date if it is still where the audit started. Two
   * audits racing (an operator clicking twice, or a cron overlapping a manual run)
   * would otherwise advance the hotel two days in one night, and every subsequent
   * charge would land on the wrong trading day.
   */
  private async advanceBusinessDate(
    actor: ActorContext,
    auditDate: BusinessDate,
  ): Promise<string> {
    return this.uow.execute(actor, async (u) => {
      const next = nextDay(auditDate);

      const updated = await u.tx
        .update(properties)
        .set({ businessDate: next, updatedAt: new Date() })
        .where(and(eq(properties.id, u.propertyId), eq(properties.businessDate, auditDate)))
        .returning();

      if (updated.length === 0) {
        // Someone else already advanced it. Not an error — the work is done.
        return `Business date already advanced past ${auditDate}.`;
      }

      u.audit({
        action: 'night_audit.date_advanced',
        entityType: 'property',
        entityId: u.propertyId,
        before: { businessDate: auditDate },
        after: { businessDate: next },
      });

      return `Business date advanced ${auditDate} → ${next}.`;
    });
  }

  // ── Run bookkeeping ───────────────────────────────────────────────────────

  private async startOrResume(actor: ActorContext, auditDate: BusinessDate) {
    return this.uow.execute(actor, async (u) => {
      const [existing] = await u.tx
        .select()
        .from(nightAuditRuns)
        .where(
          and(
            eq(nightAuditRuns.propertyId, u.propertyId),
            eq(nightAuditRuns.businessDate, auditDate),
          ),
        )
        .limit(1)
        .for('update');

      if (existing) {
        if (existing.status === 'COMPLETED') {
          throw new BadRequestException(
            `The night audit for ${auditDate} has already completed. The business date has moved on.`,
          );
        }
        return existing; // RUNNING or FAILED — resume it
      }

      const [created] = await u.tx
        .insert(nightAuditRuns)
        .values({
          id: uuidv7(),
          propertyId: u.propertyId,
          businessDate: auditDate,
          status: 'RUNNING',
          steps: [] as never,
          startedBy: actor.userId,
        })
        .returning();

      return created!;
    });
  }

  private async recordSteps(
    actor: ActorContext,
    runId: string,
    steps: StepResult[],
    status: 'RUNNING' | 'COMPLETED' | 'FAILED',
  ): Promise<void> {
    await this.uow.execute(actor, async (u) => {
      await u.tx
        .update(nightAuditRuns)
        .set({
          steps: steps as never,
          status,
          ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
        })
        .where(eq(nightAuditRuns.id, runId));
    });
  }

  private async loadProperty(propertyId: string) {
    const result = await this.tx.run(propertyId, async (tx) => {
      const [p] = await tx.select().from(properties).where(eq(properties.id, propertyId)).limit(1);
      return p;
    });

    if (!result) throw new BadRequestException('Property not found');
    return result;
  }

  private async loadPropertyTx(u: UnitOfWork) {
    const [p] = await u.tx
      .select()
      .from(properties)
      .where(eq(properties.id, u.propertyId))
      .limit(1);

    if (!p) throw new BadRequestException('Property not found');
    return p;
  }

  /** History, for the night-audit screen. */
  async history(propertyId: string, limit = 30) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select()
        .from(nightAuditRuns)
        .orderBy(sql`${nightAuditRuns.businessDate} DESC`)
        .limit(limit),
    );
  }

  // Occupancy / ADR / RevPAR reads live in the reporting module — it owns the
  // frozen snapshot. Night audit writes it and moves on.
}
