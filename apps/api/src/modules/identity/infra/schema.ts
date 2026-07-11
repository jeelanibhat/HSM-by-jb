/**
 * identity schema (TDD §4.1). Reference data — one of only two schemas that
 * other modules may hold a cross-schema FK to.
 */
import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  pgSchema,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const identitySchema = pgSchema('identity');

/** Case-insensitive text. Emails are not case-sensitive; treating them as such
 *  is how you get two accounts for Ravi@hotel.com and ravi@hotel.com. */
const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

export const users = identitySchema.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: citext('email').notNull().unique(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    status: varchar('status', { length: 16 }).notNull().default('ACTIVE'), // ACTIVE | DISABLED
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('users_email_idx').on(t.email)],
);

export const roles = identitySchema.table('roles', {
  id: uuid('id').primaryKey(),
  code: varchar('code', { length: 32 }).notNull().unique(), // ADMIN | MANAGER | FRONT_DESK | ...
});

/**
 * RBAC is per property (TDD §4.1) — a user can be FRONT_DESK at one hotel and
 * MANAGER at another. There is deliberately no global role column; every
 * permission answer must name a property.
 */
export const userPropertyRoles = identitySchema.table(
  'user_property_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.propertyId, t.roleId] }),
    index('upr_user_idx').on(t.userId),
    index('upr_property_idx').on(t.propertyId),
  ],
);
