import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Role } from '@hotelos/domain';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators';

/**
 * RBAC (TDD §9). Runs after PropertyContextGuard, so `req.role` is the caller's
 * role AT THE ACTIVE PROPERTY — not a global role, which does not exist.
 *
 * This is what makes E2E case 6 true: "housekeeping role cannot access cashiering".
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() means "any authenticated user at this property" — the guards
    // above have already established both.
    if (!required || required.length === 0) return true;

    const req = GqlExecutionContext.create(context).getContext().req;
    const role: Role | undefined = req?.role;

    if (!role || !required.includes(role)) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
