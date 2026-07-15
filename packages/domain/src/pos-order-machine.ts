/**
 * POS order machine.
 *
 * One rule carries this file: **CHARGED is terminal.**
 *
 * The moment an order's lines are on a guest's folio, the order is a historical
 * record of what was billed. Editing it afterwards — adding a coffee, changing a
 * price, deleting a line — changes what the restaurant *says* it billed without
 * changing what the guest was *actually* billed, and the two silently disagree
 * forever. Worse, it can happen after the guest has checked out and paid.
 *
 * The correction for a wrong charge is a reversing entry on the folio, which the
 * ledger already knows how to do (see voidLine and parent_line_id). Not this.
 */
import type { PosOrderStatus } from './enums.js';

const TRANSITIONS: Readonly<Record<PosOrderStatus, readonly PosOrderStatus[]>> = {
  OPEN: ['CHARGED', 'VOID'],

  /** Terminal. The guest has the bill. */
  CHARGED: [],

  /** Terminal. Cancelled before anyone was billed. */
  VOID: [],
};

export class IllegalOrderTransitionError extends Error {
  constructor(
    readonly from: PosOrderStatus,
    readonly to: PosOrderStatus,
    reason?: string,
  ) {
    super(reason ?? `Illegal POS order transition: ${from} → ${to}`);
    this.name = 'IllegalOrderTransitionError';
  }
}

export function canTransitionOrder(from: PosOrderStatus, to: PosOrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertOrderTransition(from: PosOrderStatus, to: PosOrderStatus): void {
  if (from === 'CHARGED') {
    throw new IllegalOrderTransitionError(
      from,
      to,
      'That order is already on the guest’s bill. Reverse the charge on the folio instead — the order itself is now a record of what was billed.',
    );
  }

  if (from === 'VOID') {
    throw new IllegalOrderTransitionError(from, to, 'That order was voided. Start a new one.');
  }

  if (!canTransitionOrder(from, to)) throw new IllegalOrderTransitionError(from, to);
}

/**
 * May the order still be edited?
 *
 * Adding, removing or re-pricing a line is only legal while the order is OPEN. This
 * is the check that stands between "the kitchen forgot the naan" and "the guest was
 * billed for a naan after they checked out".
 */
export function isEditable(status: PosOrderStatus): boolean {
  return status === 'OPEN';
}

/**
 * The order's total, in minor units, computed from the lines.
 *
 * Integers throughout. `qty * unitPriceMinor` cannot lose a paisa; `qty * price` in
 * rupees-as-floats can, and does, and the guest is the one who notices.
 *
 * Tax is NOT computed here. It is the folio's job, from the property's tax
 * configuration, at the moment of posting — one implementation, applied to a room
 * charge and a club sandwich alike. A POS that computed its own tax would be a second
 * opinion about GST, and the two would diverge on the first rate change.
 */
export function orderSubtotalMinor(
  lines: ReadonlyArray<{ quantity: number; unitPriceMinor: number }>,
): number {
  return lines.reduce((total, l) => total + l.quantity * l.unitPriceMinor, 0);
}
