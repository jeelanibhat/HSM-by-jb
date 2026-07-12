import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  add,
  money,
  negate,
  sum,
  taxFromBps,
  zero,
  type Money,
} from '@hotelos/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { TransactionalUnitOfWork, type ActorContext, type UnitOfWork } from '../../../shared';
import { properties, taxes } from '../../property/infra/schema';
import { folioLines, folios, invoices } from '../infra/schema';

/** Charge codes that attract tax. Payments obviously do not. */
const TAXABLE_TYPES = new Set(['CHARGE']);

export interface FolioBalance {
  charges: number;
  payments: number;
  tax: number;
  /** What the guest still owes. Zero means settled. */
  balance: number;
  currency: string;
}

@Injectable()
export class FolioService {
  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly tx: TenantTransaction,
  ) {}

  // ── Opening ───────────────────────────────────────────────────────────────

  /**
   * Open a folio. Called by check-in, inside ITS transaction — so a check-in that
   * fails for any reason cannot leave an orphan bill behind.
   */
  async openForReservation(
    u: UnitOfWork,
    reservationId: string,
    guestId: string,
    currency: string,
  ) {
    const existing = await u.tx
      .select()
      .from(folios)
      .where(and(eq(folios.reservationId, reservationId), eq(folios.type, 'GUEST')))
      .limit(1);

    // Idempotent: a re-run of check-in must not open a second bill.
    if (existing[0]) return existing[0];

    const id = uuidv7();
    const folioNo = await this.nextFolioNo(u);

    const [created] = await u.tx
      .insert(folios)
      .values({
        id,
        propertyId: u.propertyId,
        reservationId,
        guestId,
        folioNo,
        status: 'OPEN',
        type: 'GUEST',
        currency,
      })
      .returning();

    u.audit({
      action: 'folio.opened',
      entityType: 'folio',
      entityId: id,
      after: { folioNo, reservationId },
    });

    return created!;
  }

  // ── Posting ───────────────────────────────────────────────────────────────

  /**
   * Post a charge, plus its tax.
   *
   * The tax is a SEPARATE line, not folded into the charge. An invoice has to show
   * "Room 3,500 / GST 12% 420" — a single 3,920 line cannot be decomposed back into
   * those without guessing, and a GST filing that guesses is a GST filing that gets
   * audited.
   */
  async postCharge(
    actor: ActorContext,
    input: {
      folioId: string;
      code: string;
      description: string;
      amountMinor: number;
      quantity?: number;
    },
  ) {
    return this.uow.execute(actor, async (u) => {
      const folio = await this.loadOpenFolio(u, input.folioId);

      const qty = input.quantity ?? 1;
      const gross = money(input.amountMinor * qty, folio.currency);

      const businessDate = await this.currentBusinessDate(u);
      const lines = await this.buildChargeLines(u, folio, input.code, input.description, gross, businessDate, actor.userId);

      await u.tx.insert(folioLines).values(lines);

      const total = sum(
        lines.map((l) => money(l.amountMinor, folio.currency)),
        folio.currency,
      );

      u.audit({
        action: 'folio.line_posted',
        entityType: 'folio',
        entityId: folio.id,
        after: { code: input.code, amountMinor: total.minor, businessDate },
      });

      u.emit({
        aggregateType: 'folio',
        aggregateId: folio.id,
        eventType: 'folio.line_posted',
        payload: { folioId: folio.id, code: input.code, amountMinor: total.minor },
      });

      return this.balanceOf(u, folio.id, folio.currency);
    });
  }

  /**
   * Post a payment. Stored NEGATIVE — it reduces what the guest owes, and the
   * balance stays a plain SUM.
   */
  async postPayment(
    actor: ActorContext,
    input: { folioId: string; code: string; amountMinor: number; reference?: string },
  ) {
    return this.uow.execute(actor, async (u) => {
      const folio = await this.loadOpenFolio(u, input.folioId);
      const businessDate = await this.currentBusinessDate(u);

      await u.tx.insert(folioLines).values({
        id: uuidv7(),
        propertyId: actor.propertyId,
        folioId: folio.id,
        businessDate,
        type: 'PAYMENT',
        code: input.code, // CASH | CARD | UPI
        description: input.reference
          ? `${input.code} · ${input.reference}`
          : `Payment · ${input.code}`,
        amountMinor: -Math.abs(input.amountMinor), // always reduces the balance
        currency: folio.currency,
        taxAmountMinor: 0,
        sourceModule: 'folio',
        postedBy: actor.userId,
      });

      u.audit({
        action: 'folio.payment_posted',
        entityType: 'folio',
        entityId: folio.id,
        after: { code: input.code, amountMinor: -Math.abs(input.amountMinor) },
      });

      u.emit({
        aggregateType: 'folio',
        aggregateId: folio.id,
        eventType: 'folio.line_posted',
        payload: { folioId: folio.id, code: input.code, payment: true },
      });

      return this.balanceOf(u, folio.id, folio.currency);
    });
  }

  /**
   * Void a line — by REVERSING it, never by editing it (TDD §6).
   *
   * The original line stays exactly as posted. A new line of equal, opposite value
   * points back at it. The pair sums to zero, the ledger stays append-only, and an
   * auditor can see both that the charge was made and that it was reversed, by whom,
   * and why. Editing the original would erase the fact that it ever happened.
   */
  async voidLine(actor: ActorContext, folioLineId: string, reason: string) {
    return this.uow.execute(actor, async (u) => {
      const [original] = await u.tx
        .select()
        .from(folioLines)
        .where(eq(folioLines.id, folioLineId))
        .limit(1);

      if (!original) throw new NotFoundException('Folio line not found');

      // A reversal of a reversal is almost always a mistake, and it makes the
      // ledger very hard to read.
      if (original.reversesLineId) {
        throw new BadRequestException('That line is itself a reversal and cannot be voided.');
      }

      /**
       * A tax line cannot be voided on its own. There is no such thing as "the
       * charge stands but the tax on it does not" — that is either fraud or a bug.
       * Void the charge; the tax goes with it.
       */
      if (original.parentLineId) {
        throw new BadRequestException(
          'Tax cannot be voided on its own. Void the charge it belongs to and the tax is reversed with it.',
        );
      }

      const [alreadyVoided] = await u.tx
        .select()
        .from(folioLines)
        .where(eq(folioLines.reversesLineId, folioLineId))
        .limit(1);

      if (alreadyVoided) {
        throw new BadRequestException('That line has already been voided.');
      }

      const folio = await this.loadOpenFolio(u, original.folioId);
      const businessDate = await this.currentBusinessDate(u);

      /**
       * Voiding a CHARGE must also void its TAX.
       *
       * The tax is not an independent economic event — it exists only because the
       * charge does. Reversing the charge and leaving the tax means the guest keeps
       * paying GST on a line that no longer exists, and the hotel remits tax it
       * never collected. Both are reversed here, in one transaction, or neither is.
       *
       * (Voiding a TAX line on its own is not offered. There is no such thing as
       * "the charge stands but the tax on it does not".)
       */
      const children = await u.tx
        .select()
        .from(folioLines)
        .where(eq(folioLines.parentLineId, original.id));

      const toReverse = [original, ...children];
      const reversalIds: string[] = [];

      for (const line of toReverse) {
        const reversalId = uuidv7();
        reversalIds.push(reversalId);

        await u.tx.insert(folioLines).values({
          id: reversalId,
          propertyId: actor.propertyId,
          folioId: line.folioId,
          // The reversal is posted on TODAY's business date, not the original's. It
          // is a new economic event: yesterday's trading day is closed and its
          // reports have been filed. Back-dating it would silently change a number
          // someone has already reported to a tax authority.
          businessDate,
          type: 'ADJUSTMENT',
          code: line.code,
          description: `Void: ${line.description}`,
          amountMinor: -line.amountMinor,
          currency: line.currency,
          taxAmountMinor: -line.taxAmountMinor,
          reversesLineId: line.id,
          reason,
          sourceModule: 'folio',
          postedBy: actor.userId,
        });
      }

      u.audit({
        action: 'folio.line_voided',
        entityType: 'folio_line',
        entityId: original.id,
        before: { amountMinor: original.amountMinor, code: original.code },
        after: {
          reversedBy: reversalIds[0],
          taxLinesAlsoReversed: children.length,
        },
        reason,
      });

      u.emit({
        aggregateType: 'folio',
        aggregateId: original.folioId,
        eventType: 'folio.line_voided',
        payload: { folioId: original.folioId, lineId: original.id, reason },
      });

      return this.balanceOf(u, folio.id, folio.currency);
    });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async balanceOf(u: UnitOfWork, folioId: string, currency: string): Promise<FolioBalance> {
    const lines = await u.tx.select().from(folioLines).where(eq(folioLines.folioId, folioId));

    let charges = zero(currency);
    let payments = zero(currency);
    let tax = zero(currency);

    for (const l of lines) {
      const amount = money(l.amountMinor, l.currency);

      if (l.type === 'PAYMENT') payments = add(payments, amount);
      else charges = add(charges, amount);

      tax = add(tax, money(l.taxAmountMinor, l.currency));
    }

    // The whole ledger sums to the balance. No CASE, no line-type special-casing —
    // a new line type added tomorrow cannot fall out of this by being forgotten.
    const balance = sum(
      lines.map((l) => money(l.amountMinor, l.currency)),
      currency,
    );

    return {
      charges: charges.minor,
      payments: payments.minor,
      tax: tax.minor,
      balance: balance.minor,
      currency,
    };
  }

  async getFolio(propertyId: string, folioId: string) {
    return this.tx.run(propertyId, async (tx) => {
      const [folio] = await tx.select().from(folios).where(eq(folios.id, folioId)).limit(1);
      if (!folio) return null;

      const lines = await tx
        .select()
        .from(folioLines)
        .where(eq(folioLines.folioId, folioId))
        .orderBy(asc(folioLines.createdAt));

      // Which lines have been reversed — so the UI can strike them through rather
      // than pretending they never existed.
      const voidedIds = new Set(
        lines.filter((l) => l.reversesLineId).map((l) => l.reversesLineId!),
      );

      const balance = sum(
        lines.map((l) => money(l.amountMinor, l.currency)),
        folio.currency,
      );

      return {
        ...folio,
        lines: lines.map((l) => ({ ...l, voided: voidedIds.has(l.id) })),
        balanceMinor: balance.minor,
      };
    });
  }

  async findByReservation(propertyId: string, reservationId: string) {
    return this.tx.run(propertyId, async (tx) => {
      const [folio] = await tx
        .select()
        .from(folios)
        .where(eq(folios.reservationId, reservationId))
        .limit(1);
      return folio ?? null;
    });
  }

  // ── Settlement (used by check-out) ────────────────────────────────────────

  /**
   * The rule check-out hangs on (TDD §6): a folio may only close at ZERO.
   *
   * Not "close and we'll chase it" — a guest who walks out with an open balance and
   * a closed bill is money the hotel will never see, and a room that reports itself
   * as settled. If they genuinely owe nothing more, the balance IS zero. If a company
   * is paying, that transfers to the city ledger, which is an explicit act with its
   * own permission, not a side effect of check-out.
   */
  async assertSettled(u: UnitOfWork, folioId: string, currency: string): Promise<void> {
    const { balance } = await this.balanceOf(u, folioId, currency);

    if (balance > 0) {
      throw new BadRequestException(
        `Cannot check out: the folio still has an outstanding balance of ${formatMinor(balance, currency)}.`,
      );
    }

    if (balance < 0) {
      // Overpaid. Refunding is a decision, not something check-out should silently do.
      throw new BadRequestException(
        `Cannot check out: the folio is overpaid by ${formatMinor(-balance, currency)}. Refund the difference first.`,
      );
    }
  }

  async close(u: UnitOfWork, folioId: string): Promise<void> {
    await u.tx
      .update(folios)
      .set({ status: 'SETTLED', closedAt: new Date(), updatedAt: new Date() })
      .where(eq(folios.id, folioId));

    u.audit({
      action: 'folio.settled',
      entityType: 'folio',
      entityId: folioId,
      after: { status: 'SETTLED' },
    });
  }

  /** Freeze the bill into an invoice. The folio may keep moving; this does not. */
  async issueInvoice(actor: ActorContext, folioId: string) {
    return this.uow.execute(actor, async (u) => {
      const [folio] = await u.tx.select().from(folios).where(eq(folios.id, folioId)).limit(1);
      if (!folio) throw new NotFoundException('Folio not found');

      const [existing] = await u.tx
        .select()
        .from(invoices)
        .where(eq(invoices.folioId, folioId))
        .limit(1);
      if (existing) return existing; // idempotent

      const balance = await this.balanceOf(u, folioId, folio.currency);

      const rows = (await u.tx.execute(sql`
        SELECT nextval('folio.invoice_seq') AS n
      `)) as unknown as Array<{ n: string }>;

      const id = uuidv7();
      const [invoice] = await u.tx
        .insert(invoices)
        .values({
          id,
          propertyId: actor.propertyId,
          folioId,
          invoiceNo: `INV-${rows[0]!.n}`,
          totals: {
            grossMinor: balance.charges,
            taxMinor: balance.tax,
            netMinor: balance.charges - balance.tax,
            paidMinor: -balance.payments,
            balanceMinor: balance.balance,
            currency: folio.currency,
          } as never,
        })
        .returning();

      u.audit({
        action: 'invoice.issued',
        entityType: 'invoice',
        entityId: id,
        after: { invoiceNo: invoice!.invoiceNo, folioId },
      });

      return invoice!;
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async loadOpenFolio(u: UnitOfWork, folioId: string) {
    const [folio] = await u.tx
      .select()
      .from(folios)
      .where(eq(folios.id, folioId))
      .limit(1)
      .for('update');

    if (!folio) throw new NotFoundException('Folio not found');

    if (folio.status !== 'OPEN') {
      throw new BadRequestException(
        `That folio is ${folio.status.toLowerCase()} and cannot be posted to.`,
      );
    }

    return folio;
  }

  /**
   * Build the charge line and its tax lines.
   *
   * INCLUSIVE tax is already inside the price the guest was quoted — the rack rate
   * of ₹3,920 IS the ₹3,500 room plus ₹420 GST. So we split it out and the charge
   * line drops to the net. EXCLUSIVE tax sits on top and the charge line keeps its
   * full value. Getting this backwards overcharges every guest by the tax rate, or
   * undercharges the government by it.
   */
  private async buildChargeLines(
    u: UnitOfWork,
    folio: typeof folios.$inferSelect,
    code: string,
    description: string,
    gross: Money,
    businessDate: string,
    userId: string,
  ) {
    const applicable = await u.tx
      .select()
      .from(taxes)
      .where(eq(taxes.propertyId, u.propertyId));

    const relevant = applicable.filter(
      (t) =>
        TAXABLE_TYPES.has('CHARGE') &&
        (t.appliesAboveMinor === null || gross.minor > t.appliesAboveMinor),
    );

    const chargeId = uuidv7();
    const lines: Array<typeof folioLines.$inferInsert> = [];

    let net = gross;
    const taxLines: Array<{ name: string; amount: Money }> = [];

    for (const t of relevant) {
      const mode = t.type === 'INCLUSIVE' ? 'INCLUSIVE' : 'EXCLUSIVE';
      const taxAmount = taxFromBps(gross, t.rateBps, mode);

      if (mode === 'INCLUSIVE') {
        // Carve the tax OUT of the quoted price.
        net = add(net, negate(taxAmount));
      }

      taxLines.push({ name: t.name, amount: taxAmount });
    }

    lines.push({
      id: chargeId,
      propertyId: u.propertyId,
      folioId: folio.id,
      businessDate,
      type: 'CHARGE',
      code,
      description,
      amountMinor: net.minor,
      currency: folio.currency,
      taxAmountMinor: 0,
      sourceModule: 'folio',
      postedBy: userId,
    });

    for (const t of taxLines) {
      lines.push({
        id: uuidv7(),
        propertyId: u.propertyId,
        folioId: folio.id,
        businessDate,
        type: 'TAX',
        code: 'TAX',
        description: t.name,
        amountMinor: t.amount.minor,
        currency: folio.currency,
        taxAmountMinor: t.amount.minor,
        // The link that lets a void of the charge take its tax with it.
        parentLineId: chargeId,
        sourceModule: 'folio',
        postedBy: userId,
      });
    }

    return lines;
  }

  /** The property's BUSINESS date — never `new Date()` (TDD §6). */
  private async currentBusinessDate(u: UnitOfWork): Promise<string> {
    const [property] = await u.tx
      .select({ businessDate: properties.businessDate })
      .from(properties)
      .where(eq(properties.id, u.propertyId))
      .limit(1);

    if (!property) throw new NotFoundException('Property not found');
    return property.businessDate;
  }

  private async nextFolioNo(u: UnitOfWork): Promise<string> {
    const rows = (await u.tx.execute(
      sql`SELECT nextval('folio.folio_seq') AS n`,
    )) as unknown as Array<{ n: string }>;

    return `F-${rows[0]!.n}`;
  }
}

function formatMinor(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}
