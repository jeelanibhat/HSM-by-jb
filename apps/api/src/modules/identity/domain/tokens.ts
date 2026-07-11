import type { Role } from '@hotelos/domain';

/**
 * Token shapes (TDD §3): short-lived access JWT + rotating refresh token.
 *
 * The access token carries the user's role AT EACH PROPERTY, because RBAC is
 * per-property — a user can be FRONT_DESK at one hotel and MANAGER at another
 * (TDD §4.1). There is deliberately no global role.
 */

export interface PropertyRole {
  propertyId: string;
  role: Role;
}

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  name: string;
  roles: PropertyRole[];
  typ: 'access';
}

/**
 * The refresh token carries no roles and no email — only enough to look itself up.
 * If it leaks, it reveals nothing about the user, and `jti` lets us revoke it.
 *
 * `fam` is the token family: every refresh issued from one login shares it. That
 * is what makes reuse detection possible (see SessionStore.rotate).
 */
export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  fam: string;
  typ: 'refresh';
}

/** The authenticated caller, attached to the request by JwtAuthGuard. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  roles: PropertyRole[];
}

/** Resolved tenancy for this request — set by PropertyContextGuard. */
export interface RequestContext {
  user: AuthenticatedUser;
  propertyId: string;
  role: Role;
}
