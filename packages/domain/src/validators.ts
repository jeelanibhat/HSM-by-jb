/**
 * Zod validators shared by the API (resolver input validation) and the web app
 * (react-hook-form resolvers) — TDD §7.1, one definition, two consumers.
 */
import { z } from 'zod';
import {
  FOLIO_LINE_TYPES,
  HOUSEKEEPING_TASK_TYPES,
  RESERVATION_SOURCES,
  ROLES,
  ROOM_STATUSES,
} from './enums.js';

export const uuidSchema = z.string().uuid();

export const businessDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Not a real calendar date');

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Must be an ISO-4217 code');

/** Minor units. Integer, never a float. */
export const moneyMinorSchema = z
  .number()
  .int('Amount must be in whole minor units (paise/cents)')
  .safe();

export const emailSchema = z.string().email().max(254);

// E.164-ish; deliberately permissive because front desks type what the guest says.
export const phoneSchema = z
  .string()
  .min(6)
  .max(20)
  .regex(/^\+?[\d\s\-()]+$/, 'Invalid phone number');

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

export const stayDatesSchema = z
  .object({
    arrivalDate: businessDateSchema,
    departureDate: businessDateSchema,
  })
  .refine((v) => v.departureDate > v.arrivalDate, {
    message: 'Departure must be after arrival',
    path: ['departureDate'],
  });

export const guestSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  idType: z.enum(['PASSPORT', 'DRIVING_LICENSE', 'NATIONAL_ID', 'AADHAAR', 'OTHER']).optional(),
  idNumber: z.string().trim().max(64).optional(),
  address: z
    .object({
      line1: z.string().max(200).optional(),
      line2: z.string().max(200).optional(),
      city: z.string().max(100).optional(),
      state: z.string().max(100).optional(),
      country: z.string().length(2).optional(), // ISO-3166 alpha-2
      postalCode: z.string().max(20).optional(),
    })
    .optional(),
});

export const reservationRoomSchema = z.object({
  roomTypeId: uuidSchema,
  ratePlanId: uuidSchema,
  roomId: uuidSchema.optional(), // assigned later
  adults: z.number().int().min(1).max(10),
  children: z.number().int().min(0).max(10),
});

export const createReservationSchema = z
  .object({
    guestId: uuidSchema.optional(),
    guest: guestSchema.optional(),
    source: z.enum(RESERVATION_SOURCES),
    arrivalDate: businessDateSchema,
    departureDate: businessDateSchema,
    rooms: z.array(reservationRoomSchema).min(1, 'At least one room is required'),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.departureDate > v.arrivalDate, {
    message: 'Departure must be after arrival',
    path: ['departureDate'],
  })
  .refine((v) => Boolean(v.guestId) !== Boolean(v.guest), {
    message: 'Provide exactly one of guestId or guest',
    path: ['guestId'],
  });

export const postChargeSchema = z.object({
  folioId: uuidSchema,
  code: z.string().trim().min(1).max(32), // ROOM, F&B, LAUNDRY...
  description: z.string().trim().min(1).max(255),
  amountMinor: moneyMinorSchema.positive('Charge must be positive'),
  currency: currencySchema,
  quantity: z.number().int().min(1).default(1),
});

export const postPaymentSchema = z.object({
  folioId: uuidSchema,
  code: z.string().trim().min(1).max(32), // CASH, CARD, UPI...
  amountMinor: moneyMinorSchema.positive('Payment must be positive'),
  currency: currencySchema,
  reference: z.string().max(128).optional(),
});

/** Destructive ops require a reason — it feeds the audit log (TDD §7.4). */
export const voidLineSchema = z.object({
  folioLineId: uuidSchema,
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});

export const cancelReservationSchema = z.object({
  reservationId: uuidSchema,
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});

export const updateRoomStatusSchema = z.object({
  roomId: uuidSchema,
  status: z.enum(ROOM_STATUSES),
  /** Taking a room OOO is disruptive; the audit log wants to know why. */
  reason: z.string().trim().max(500).optional(),
});

// ── Inventory (TDD §4.2) ────────────────────────────────────────────────────

/** Short code used on the tape chart and in reports — DLX, STD, SUITE. */
export const codeSchema = z
  .string()
  .trim()
  .min(1)
  .max(16)
  .regex(/^[A-Z0-9_-]+$/, 'Use upper-case letters, digits, - or _');

export const createRoomTypeSchema = z
  .object({
    code: codeSchema,
    name: z.string().trim().min(1).max(100),
    baseOccupancy: z.number().int().min(1).max(10),
    maxOccupancy: z.number().int().min(1).max(10),
    description: z.string().max(1000).optional(),
  })
  .refine((v) => v.maxOccupancy >= v.baseOccupancy, {
    message: 'Max occupancy cannot be below base occupancy',
    path: ['maxOccupancy'],
  });

export const createRoomSchema = z.object({
  roomTypeId: uuidSchema,
  // Hotel room numbers are not integers: '12A', 'P-1', '0101' all occur.
  number: z.string().trim().min(1).max(16),
  floor: z.string().trim().max(16).optional(),
});

export const createRatePlanSchema = z.object({
  code: codeSchema,
  name: z.string().trim().min(1).max(100),
  currency: currencySchema,
  mealPlan: z.enum(['EP', 'CP', 'MAP', 'AP']).default('EP'), // room-only → all-inclusive
  description: z.string().max(1000).optional(),
});

/**
 * Set prices across a date range in one shot. A front office does not price
 * 365 days one at a time.
 */
export const setRatePricesSchema = z
  .object({
    ratePlanId: uuidSchema,
    roomTypeId: uuidSchema,
    from: businessDateSchema,
    to: businessDateSchema, // inclusive — you are pricing days, not a stay
    priceMinor: moneyMinorSchema.min(0, 'Price cannot be negative'),
  })
  .refine((v) => v.to >= v.from, {
    message: 'End date cannot be before start date',
    path: ['to'],
  });

export type CreateRoomTypeInput = z.infer<typeof createRoomTypeSchema>;
export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type CreateRatePlanInput = z.infer<typeof createRatePlanSchema>;
export type SetRatePricesInput = z.infer<typeof setRatePricesSchema>;
export type UpdateRoomStatusInput = z.infer<typeof updateRoomStatusSchema>;

// ── Housekeeping (Phase 2) ──────────────────────────────────────────────────

export const housekeepingTaskTypeSchema = z.enum(HOUSEKEEPING_TASK_TYPES);

/** Build the day's board from who is departing and who is staying over. */
export const generateHousekeepingBoardSchema = z.object({
  businessDate: businessDateSchema.optional(),
});

export const assignHousekeepingTaskSchema = z.object({
  taskId: uuidSchema,
  /** null un-assigns — the task goes back on the board for anyone to pick up. */
  assignedTo: uuidSchema.nullable(),
});

export const startHousekeepingTaskSchema = z.object({ taskId: uuidSchema });

export const completeHousekeepingTaskSchema = z.object({
  taskId: uuidSchema,
  notes: z.string().trim().max(500).optional(),
});

export const inspectHousekeepingTaskSchema = z.object({
  taskId: uuidSchema,
  passed: z.boolean(),
  /**
   * A failed inspection sends the room back to dirty and the attendant back to the
   * room. They are owed a reason — "failed" on its own is not actionable.
   */
  reason: z.string().trim().max(500).optional(),
});

export const createHousekeepingTaskSchema = z.object({
  roomId: uuidSchema,
  type: housekeepingTaskTypeSchema,
  businessDate: businessDateSchema.optional(),
  notes: z.string().trim().max(500).optional(),
});

export type GenerateHousekeepingBoardInput = z.infer<typeof generateHousekeepingBoardSchema>;
export type AssignHousekeepingTaskInput = z.infer<typeof assignHousekeepingTaskSchema>;
export type StartHousekeepingTaskInput = z.infer<typeof startHousekeepingTaskSchema>;
export type CompleteHousekeepingTaskInput = z.infer<typeof completeHousekeepingTaskSchema>;
export type InspectHousekeepingTaskInput = z.infer<typeof inspectHousekeepingTaskSchema>;
export type CreateHousekeepingTaskInput = z.infer<typeof createHousekeepingTaskSchema>;

export const folioLineTypeSchema = z.enum(FOLIO_LINE_TYPES);
export const roleSchema = z.enum(ROLES);

export type LoginInput = z.infer<typeof loginSchema>;
export type GuestInput = z.infer<typeof guestSchema>;
export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type PostChargeInput = z.infer<typeof postChargeSchema>;
export type PostPaymentInput = z.infer<typeof postPaymentSchema>;
export type VoidLineInput = z.infer<typeof voidLineSchema>;
