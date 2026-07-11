/**
 * DI tokens and types, in their own file to break a circular import.
 *
 * db.module imports TenantTransaction (to provide it); TenantTransaction needs the
 * DB token (to inject it). If the token lived in db.module, that cycle would leave
 * `DB` as `undefined` at the moment @Inject(DB) is evaluated, and Nest would fail
 * with the famously unhelpful "argument at index [0] is available?".
 *
 * A leaf module with no imports of its own cannot participate in a cycle.
 */
import type { drizzle } from 'drizzle-orm/postgres-js';
import type * as schema from './schema/index';

export const DB = Symbol('DB');
export const PG_CLIENT = Symbol('PG_CLIENT');

export type Database = ReturnType<typeof drizzle<typeof schema>>;
