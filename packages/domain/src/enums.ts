/**
 * Domain enums shared by API and web. These mirror the Postgres enum/check
 * constraints — changing one means a migration.
 */

export const RESERVATION_STATUSES = [
  'ENQUIRY',
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const RESERVATION_SOURCES = [
  'WALK_IN',
  'DIRECT',
  'PHONE',
  'OTA',
  'BOOKING_ENGINE',
] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

/** Physical/sellable state of a room. OOO = out of order, OOS = out of service. */
export const ROOM_STATUSES = [
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'OCCUPIED',
  'OOO',
  'OOS',
] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/**
 * Housekeeping work is a TASK, not a room status. The room already has a status
 * (ROOM_STATUSES) — what a room needs today, who is doing it, and whether anyone
 * checked afterwards is a separate thing with its own life.
 *
 *   DEPARTURE  — the guest has gone; a full turnover before the next arrival
 *   STAYOVER   — the guest is still in the room; a service clean
 *   DEEP_CLEAN — periodic, or after an OOO repair
 *   TURNDOWN   — evening service
 */
export const HOUSEKEEPING_TASK_TYPES = [
  'DEPARTURE',
  'STAYOVER',
  'DEEP_CLEAN',
  'TURNDOWN',
] as const;
export type HousekeepingTaskType = (typeof HOUSEKEEPING_TASK_TYPES)[number];

/**
 * DONE means "the attendant says it is clean". INSPECTED means "a supervisor
 * looked". They are deliberately not the same state — collapsing them is how a
 * room gets sold on somebody's word.
 */
export const HOUSEKEEPING_TASK_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'INSPECTED',
] as const;
export type HousekeepingTaskStatus = (typeof HOUSEKEEPING_TASK_STATUSES)[number];

export const FOLIO_STATUSES = ['OPEN', 'CLOSED', 'SETTLED'] as const;
export type FolioStatus = (typeof FOLIO_STATUSES)[number];

export const FOLIO_TYPES = ['GUEST', 'MASTER', 'CITY_LEDGER'] as const;
export type FolioType = (typeof FOLIO_TYPES)[number];

export const FOLIO_LINE_TYPES = ['CHARGE', 'PAYMENT', 'TAX', 'ADJUSTMENT'] as const;
export type FolioLineType = (typeof FOLIO_LINE_TYPES)[number];

/**
 * POS_OPERATOR is a waiter, not a receptionist. They take orders and send them to a
 * room — and that is ALL they can do. They cannot see the guest's bill, take a
 * payment, or check anyone in. Giving a restaurant tablet the front desk's authority
 * because both "touch the folio" is how a POS terminal becomes the softest way into
 * a hotel's cashiering.
 */
export const ROLES = [
  'ADMIN',
  'MANAGER',
  'FRONT_DESK',
  'HOUSEKEEPING',
  'POS_OPERATOR',
  'AUDITOR',
] as const;
export type Role = (typeof ROLES)[number];

/**
 * An order's life.
 *
 *   OPEN    — being taken; lines can still be added and removed
 *   CHARGED — on a guest's folio. IMMUTABLE from here: the guest has the bill.
 *   VOID    — cancelled before it was charged. Nobody paid for anything.
 *
 * There is deliberately no edge out of CHARGED. Once a line is on a guest's bill,
 * the correction is a reversing entry on the FOLIO (which the ledger already does,
 * with parent_line_id), not a quiet edit to the order that produced it. An order that
 * can be changed after it was billed is an order that can be changed after the guest
 * has checked out.
 */
export const POS_ORDER_STATUSES = ['OPEN', 'CHARGED', 'VOID'] as const;
export type PosOrderStatus = (typeof POS_ORDER_STATUSES)[number];

export const NIGHT_AUDIT_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED'] as const;
export type NightAuditStatus = (typeof NIGHT_AUDIT_STATUSES)[number];

/**
 * One outbound availability/rate push to a channel.
 *
 *   PENDING — queued after a booking moved inventory; not yet sent
 *   SENT    — the channel acknowledged it. Terminal for THIS push.
 *   FAILED  — the channel rejected it or was unreachable; will be retried
 *
 * A push is a snapshot, never a delta: we always send the CURRENT availability for a
 * room-type/date range, so a lost or reordered push is corrected by the next one
 * rather than compounding. FAILED → PENDING is the retry; there is no edge out of
 * SENT because the row records one attempt's outcome, and the next change makes a new
 * row.
 */
export const CHANNEL_OUTBOUND_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
export type ChannelOutboundStatus = (typeof CHANNEL_OUTBOUND_STATUSES)[number];

/**
 * The fate of one inbound booking an OTA handed us.
 *
 *   RECEIVED  — accepted off the wire, not yet turned into a reservation
 *   CONFIRMED — a reservation exists for it. Terminal.
 *   REJECTED  — we could not honour it: the room was gone (oversell) or the channel
 *               named a room/rate code we have no mapping for. Terminal.
 *   DUPLICATE — the OTA delivered a booking reference we have already seen. Terminal;
 *               the reservation from the first delivery stands.
 *
 * All three end states are terminal on purpose: an OTA booking's outcome is a fact
 * about one delivery, and a redelivery is a DUPLICATE, not a state change.
 */
export const CHANNEL_DELIVERY_STATUSES = ['RECEIVED', 'CONFIRMED', 'REJECTED', 'DUPLICATE'] as const;
export type ChannelDeliveryStatus = (typeof CHANNEL_DELIVERY_STATUSES)[number];
