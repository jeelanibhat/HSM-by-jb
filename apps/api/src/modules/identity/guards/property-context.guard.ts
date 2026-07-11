import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { IS_PUBLIC_KEY, SKIP_PROPERTY_KEY } from './decorators';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tenancy (TDD §5.1): "All operations resolve within the caller's property context
 * (X-Property-Id header validated against RBAC claims)."
 *
 * The header is CLIENT-SUPPLIED and therefore hostile. It is only trusted after we
 * confirm the authenticated user actually holds a role at that property. Skipping
 * this check would let any logged-in user read any hotel's data simply by changing
 * a header — and, because the app sets the RLS GUC from this value, RLS would
 * happily co-operate.
 */
@Injectable()
export class PropertyContextGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_PROPERTY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip || isPublic) return true;

    const req = GqlExecutionContext.create(context).getContext().req;
    const user = req?.user;

    if (!user) throw new ForbiddenException('No authenticated user');

    const propertyId: string | undefined = req.headers?.['x-property-id'];

    if (!propertyId) {
      throw new ForbiddenException('X-Property-Id header is required');
    }

    // The value is interpolated into set_config() downstream. Validate the shape
    // here so a malformed id can never reach the database layer.
    if (!UUID_RE.test(propertyId)) {
      throw new ForbiddenException('X-Property-Id must be a UUID');
    }

    // The claim that matters: does this user actually work at this hotel?
    const grant = user.roles?.find(
      (r: { propertyId: string }) => r.propertyId === propertyId,
    );

    if (!grant) {
      // Deliberately does not distinguish "property does not exist" from "you have
      // no role there" — that difference would enumerate our customers' properties.
      throw new ForbiddenException('You do not have access to this property');
    }

    req.propertyId = propertyId;
    req.role = grant.role;

    return true;
  }
}
