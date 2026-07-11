/**
 * Zod validators shared by the API (resolver input validation) and the web app
 * (react-hook-form resolvers) — TDD §7.1, one definition, two consumers.
 */
import { z } from 'zod';
import {
  FOLIO_LINE_TYPES,
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
});

export const folioLineTypeSchema = z.enum(FOLIO_LINE_TYPES);
export const roleSchema = z.enum(ROLES);

export type LoginInput = z.infer<typeof loginSchema>;
export type GuestInput = z.infer<typeof guestSchema>;
export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type PostChargeInput = z.infer<typeof postChargeSchema>;
export type PostPaymentInput = z.infer<typeof postPaymentSchema>;
export type VoidLineInput = z.infer<typeof voidLineSchema>;
