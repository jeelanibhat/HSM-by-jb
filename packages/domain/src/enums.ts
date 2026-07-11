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

export const HOUSEKEEPING_STATUSES = ['CLEAN', 'DIRTY', 'INSPECTED', 'IN_PROGRESS'] as const;
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];

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
