import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  assertOrderTransition,
  IllegalOrderTransitionError,
  isEditable,
  orderSubtotalMinor,
  type PosOrderStatus,
} from '@hotelos/domain';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { TransactionalUnitOfWork, type ActorContext, type UnitOfWork } from '../../../shared';
import { FolioService } from '../../folio';
import { rooms } from '../../inventory/infra/schema';
import { properties } from '../../property/infra/schema';
import { menuItems, orderLines, orders, outlets } from '../infra/schema';

@Injectable()
export class PosService {
  constructor(
    private readonly uow: TransactionalUnitOfWork,
    private readonly tx: TenantTransaction,
    private readonly folio: FolioService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async listOutlets(propertyId: string) {
    return this.tx.run(propertyId, (tx) =>
      tx.select().from(outlets).where(eq(outlets.active, true)).orderBy(asc(outlets.name)),
    );
  }

  async listMenu(propertyId: string, outletId: string) {
    return this.tx.run(propertyId, (tx) =>
      tx
        .select()
        .from(menuItems)
        .where(and(eq(menuItems.outletId, outletId), eq(menuItems.active, true)))
        .orderBy(asc(menuItems.category), asc(menuItems.name)),
    );
  }

  /** Open orders — the ones still on the pass. */
  async openOrders(propertyId: string, outletId?: string) {
    return this.tx.run(propertyId, async (tx) => {
      const rows = await tx
        .select()
        .from(orders)
        .where(
          outletId
            ? and(eq(orders.status, 'OPEN'), eq(orders.outletId, outletId))
            : eq(orders.status, 'OPEN'),
        )
        .orderBy(desc(orders.createdAt));

      return Promise.all(rows.map((o) => this.withLines(tx, o)));
    });
  }

  async getOrder(propertyId: string, orderId: string) {
    return this.tx.run(propertyId, async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new NotFoundException('Order not found');

      return this.withLines(tx, order);
    });
  }

  /**
   * The rooms a waiter may charge to: the ones with a guest actually in them.
   *
   * This list IS the security boundary made visible. A waiter cannot pick a vacant
   * room, or a room whose guest left this morning, because those rooms are not on it —
   * and the charge path re-checks anyway, because a list is a convenience and never a
   * guarantee.
   *
   * It deliberately carries the guest's NAME and nothing else. A waiter needs to say
   * "Mr Sharma in 204?" out loud to confirm they have the right table. They do not
   * need — and do not get — the balance, the folio, or what anyone else has spent.
   */
  async chargeableRooms(propertyId: string) {
    return this.tx.run(propertyId, (tx) =>
      tx.execute(sql`
        SELECT r.id                                            AS "roomId",
               r.number                                        AS "roomNumber",
               g.first_name || ' ' || g.last_name              AS "guestName"
        FROM inventory.rooms r
        JOIN reservations.reservation_rooms rr ON rr.room_id = r.id
        JOIN reservations.reservations res     ON res.id = rr.reservation_id
        JOIN guests.guests g                   ON g.id = res.guest_id
        JOIN folio.folios f                    ON f.reservation_id = res.id AND f.status = 'OPEN'
        WHERE res.status = 'CHECKED_IN'
        ORDER BY r.number
      `),
    );
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  async openOrder(actor: ActorContext, input: { outletId: string; tableRef?: string }) {
    return this.uow.execute(actor, async (u) => {
      const [outlet] = await u.tx
        .select()
        .from(outlets)
        .where(eq(outlets.id, input.outletId))
        .limit(1);

      if (!outlet) throw new NotFoundException('Outlet not found');
      if (!outlet.active) throw new BadRequestException(`${outlet.name} is closed.`);

      const id = uuidv7();

      const [created] = await u.tx
        .insert(orders)
        .values({
          id,
          propertyId: actor.propertyId,
          outletId: input.outletId,
          orderNo: await this.nextOrderNo(u),
          status: 'OPEN',
          tableRef: input.tableRef ?? null,
          businessDate: await this.currentBusinessDate(u),
          openedBy: actor.userId,
        })
        .returning();

      u.audit({
        action: 'pos.order_opened',
        entityType: 'pos_order',
        entityId: id,
        after: { orderNo: created!.orderNo, outlet: outlet.code, tableRef: input.tableRef },
      });

      // Through withLines, so a fresh order has the same shape as every other one —
      // an empty `lines` and a subtotal of zero, not a missing field.
      return this.withLines(u.tx, created!);
    });
  }

  /**
   * Add an item.
   *
   * The price is taken from the MENU, server-side, and copied onto the line. It is
   * never accepted from the client: a POS that lets the caller name the price is a POS
   * that can sell a bottle of wine for one rupee, and the audit trail will faithfully
   * record that this is what happened.
   */
  async addLine(
    actor: ActorContext,
    input: { orderId: string; menuItemId: string; quantity: number; notes?: string },
  ) {
    return this.uow.execute(actor, async (u) => {
      const order = await this.lockEditableOrder(u, input.orderId);

      const [item] = await u.tx
        .select()
        .from(menuItems)
        .where(eq(menuItems.id, input.menuItemId))
        .limit(1);

      if (!item) throw new NotFoundException('That item is not on the menu');
      if (!item.active) throw new BadRequestException(`${item.name} is off the menu.`);

      if (item.outletId !== order.outletId) {
        // The bar's menu cannot be ordered from the spa's tab.
        throw new BadRequestException('That item belongs to a different outlet.');
      }

      await u.tx.insert(orderLines).values({
        id: uuidv7(),
        propertyId: actor.propertyId,
        orderId: order.id,
        menuItemId: item.id,
        description: item.name,
        unitPriceMinor: item.priceMinor,
        quantity: input.quantity,
        notes: input.notes ?? null,
      });

      u.audit({
        action: 'pos.line_added',
        entityType: 'pos_order',
        entityId: order.id,
        after: {
          item: item.name,
          quantity: input.quantity,
          unitPriceMinor: item.priceMinor,
        },
      });

      return this.withLines(u.tx, order);
    });
  }

  async removeLine(actor: ActorContext, input: { orderId: string; lineId: string }) {
    return this.uow.execute(actor, async (u) => {
      const order = await this.lockEditableOrder(u, input.orderId);

      const [line] = await u.tx
        .select()
        .from(orderLines)
        .where(and(eq(orderLines.id, input.lineId), eq(orderLines.orderId, order.id)))
        .limit(1);

      if (!line) throw new NotFoundException('That line is not on this order');

      await u.tx.delete(orderLines).where(eq(orderLines.id, input.lineId));

      u.audit({
        action: 'pos.line_removed',
        entityType: 'pos_order',
        entityId: order.id,
        before: { item: line.description, quantity: line.quantity },
      });

      return this.withLines(u.tx, order);
    });
  }

  /**
   * Send the order to a room.
   *
   * This is the whole module. Four things have to be true, and each of them is a way
   * a real hotel loses money or bills the wrong person:
   *
   *   1. The order is OPEN. The state machine refuses a second charge, and the row is
   *      locked first, so a double-tap on the waiter's tablet cannot slip between the
   *      check and the write.
   *   2. The order has lines. Charging ₹0 to a room is a folio line that means nothing
   *      and a report that has to explain it.
   *   3. The ROOM HAS A GUEST IN IT, right now, with an open folio. Not "the room
   *      exists" — a room that is vacant, or that a different guest checked into this
   *      morning, has no bill to charge. This is the check that stops a departed guest
   *      being billed for someone else's dinner.
   *   4. It all commits together. The order becoming CHARGED and the lines landing on
   *      the folio are ONE transaction, so there is no window in which the restaurant
   *      thinks it billed a meal that the guest will never see, or the guest is billed
   *      for a meal the restaurant still thinks is open.
   *
   * The TAX is not computed here. postChargeWithin does it, from the property's tax
   * configuration — the same code that taxes a room charge. A POS with its own opinion
   * about GST is a second opinion, and they diverge on the first rate change.
   */
  async chargeToRoom(actor: ActorContext, input: { orderId: string; roomId: string }) {
    return this.uow.execute(actor, async (u) => {
      const order = await this.lockOrder(u, input.orderId);

      try {
        assertOrderTransition(order.status as PosOrderStatus, 'CHARGED');
      } catch (err) {
        if (err instanceof IllegalOrderTransitionError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }

      const lines = await u.tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.orderId, order.id));

      if (lines.length === 0) {
        throw new BadRequestException('That order is empty — there is nothing to charge.');
      }

      const [room] = await u.tx.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1);
      if (!room) throw new NotFoundException('Room not found');

      // The question the restaurant is actually asking: whose bill is room 204?
      const target = await this.folio.openFolioForRoom(u, input.roomId);

      if (!target) {
        throw new BadRequestException(
          `Room ${room.number} has no guest checked in — there is no bill to charge it to.`,
        );
      }

      const [outlet] = await u.tx
        .select()
        .from(outlets)
        .where(eq(outlets.id, order.outletId))
        .limit(1);

      const subtotal = orderSubtotalMinor(lines);

      /**
       * One folio line for the order, not one per dish.
       *
       * A guest's bill should read "Restaurant · Order R-00042 — ₹1,025", not fourteen
       * lines of curry. The itemisation lives here, on the order, and the folio line
       * names the order that produced it — so the detail is one click away and the
       * bill stays legible.
       */
      const balance = await this.folio.postChargeWithin(u, actor, {
        folioId: target.folioId,
        code: outlet!.chargeCode,
        description: `${outlet!.name} · Order ${order.orderNo}${
          order.tableRef ? ` (${order.tableRef})` : ''
        }`,
        amountMinor: subtotal,
      });

      const [charged] = await u.tx
        .update(orders)
        .set({
          status: 'CHARGED',
          folioId: target.folioId,
          roomId: input.roomId,
          chargedSubtotalMinor: subtotal,
          chargedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id))
        .returning();

      u.audit({
        action: 'pos.order_charged',
        entityType: 'pos_order',
        entityId: order.id,
        after: {
          orderNo: order.orderNo,
          roomNumber: room.number,
          folioId: target.folioId,
          subtotalMinor: subtotal,
        },
      });

      u.emit({
        aggregateType: 'pos_order',
        aggregateId: order.id,
        eventType: 'pos.order_charged',
        payload: {
          orderId: order.id,
          orderNo: order.orderNo,
          folioId: target.folioId,
          roomNumber: room.number,
          subtotalMinor: subtotal,
        },
      });

      /**
       * `balance` is deliberately DROPPED here.
       *
       * postChargeWithin returns the guest's running balance, and the waiter must not
       * see it. The service holds it for a moment and throws it away; the resolver
       * never gets the chance to leak it. Redacting at the edge would work until
       * somebody added a field.
       */
      void balance;

      return {
        order: await this.withLines(u.tx, charged!),
        roomNumber: room.number,
        /** What went on the bill, before tax. The folio holds the tax lines. */
        chargedMinor: subtotal,
      };
    });
  }

  /** Cancel an order nobody was billed for. */
  async voidOrder(actor: ActorContext, input: { orderId: string; reason: string }) {
    return this.uow.execute(actor, async (u) => {
      const order = await this.lockOrder(u, input.orderId);

      try {
        assertOrderTransition(order.status as PosOrderStatus, 'VOID');
      } catch (err) {
        if (err instanceof IllegalOrderTransitionError) {
          // "It is already on the guest's bill — reverse the charge on the folio."
          throw new BadRequestException(err.message);
        }
        throw err;
      }

      const [voided] = await u.tx
        .update(orders)
        .set({ status: 'VOID', voidReason: input.reason, updatedAt: new Date() })
        .where(eq(orders.id, order.id))
        .returning();

      u.audit({
        action: 'pos.order_voided',
        entityType: 'pos_order',
        entityId: order.id,
        before: { status: order.status },
        after: { status: 'VOID' },
        reason: input.reason,
      });

      return this.withLines(u.tx, voided!);
    });
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async lockOrder(u: UnitOfWork, orderId: string) {
    const [order] = await u.tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1)
      .for('update');

    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /** Locked AND still editable — the guard on every line-level write. */
  private async lockEditableOrder(u: UnitOfWork, orderId: string) {
    const order = await this.lockOrder(u, orderId);

    if (!isEditable(order.status as PosOrderStatus)) {
      throw new BadRequestException(
        order.status === 'CHARGED'
          ? 'That order is already on the guest’s bill and cannot be changed. Reverse the charge on the folio instead.'
          : 'That order was voided.',
      );
    }

    return order;
  }

  private async withLines(tx: UnitOfWork['tx'], order: typeof orders.$inferSelect) {
    const lines = await tx
      .select()
      .from(orderLines)
      .where(eq(orderLines.orderId, order.id))
      .orderBy(asc(orderLines.createdAt));

    return { ...order, lines, subtotalMinor: orderSubtotalMinor(lines) };
  }

  private async currentBusinessDate(u: UnitOfWork): Promise<string> {
    const [property] = await u.tx
      .select({ businessDate: properties.businessDate })
      .from(properties)
      .where(eq(properties.id, u.propertyId))
      .limit(1);

    if (!property) throw new NotFoundException('Property not found');
    return property.businessDate;
  }

  /**
   * The next order number for this property.
   *
   * Derived from the count of orders, then made unique by the constraint on
   * (property_id, order_no): two waiters opening a tab in the same millisecond get the
   * same candidate, and one of them loses. The retry belongs at the caller — which is
   * why this is here and not inlined: when POS gets busy enough for that to happen in
   * practice, this is the one function to fix.
   */
  private async nextOrderNo(u: UnitOfWork): Promise<string> {
    const [row] = await u.tx.execute<{ n: number }>(sql`
      SELECT COALESCE(MAX(SUBSTRING(order_no FROM 3)::int), 0) + 1 AS n
      FROM pos.orders
      WHERE property_id = ${u.propertyId} AND order_no ~ '^R-[0-9]+$'
    `);

    return `R-${String(row?.n ?? 1).padStart(5, '0')}`;
  }
}
