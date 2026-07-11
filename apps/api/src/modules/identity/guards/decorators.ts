import { SetMetadata } from '@nestjs/common';
import type { Role } from '@hotelos/domain';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { AuthenticatedUser } from '../domain/tokens';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';
export const SKIP_PROPERTY_KEY = 'skipProperty';

/**
 * Opt OUT of authentication. Auth is on by default (the guards are global), so
 * forgetting a decorator leaves an endpoint locked, not open — fail closed.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restrict to roles AT THE ACTIVE PROPERTY. RBAC is never global (TDD §4.1). */
export const Roles = (...allowed: Role[]) => SetMetadata(ROLES_KEY, allowed);

/**
 * For authenticated operations that are not scoped to one property — `me`, and
 * "which properties can I access?". Everything else must name a property.
 */
export const NoPropertyContext = () => SetMetadata(SKIP_PROPERTY_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const ctx = GqlExecutionContext.create(context);
    return ctx.getContext().req.user;
  },
);

/** The validated active property. Guaranteed present wherever the guard ran. */
export const PropertyId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const ctx = GqlExecutionContext.create(context);
    return ctx.getContext().req.propertyId;
  },
);
