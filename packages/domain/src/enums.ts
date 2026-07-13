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

export const ROLES = ['ADMIN', 'MANAGER', 'FRONT_DESK', 'HOUSEKEEPING', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];

export const NIGHT_AUDIT_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED'] as const;
export type NightAuditStatus = (typeof NIGHT_AUDIT_STATUSES)[number];
