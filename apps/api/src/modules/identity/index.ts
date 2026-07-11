/**
 * identity — PUBLIC API (TDD §2.1).
 *
 * This is the ONLY surface other modules may import. Reaching into
 * identity/application, identity/infra or identity/domain from another module is
 * a lint error (see apps/api/eslint.config.mjs).
 */
export { IdentityModule } from './identity.module';
export { AuthService } from './application/auth.service';
export { PasswordService } from './infra/password.service';

export { JwtAuthGuard } from './guards/jwt-auth.guard';
export { PropertyContextGuard } from './guards/property-context.guard';
export { RolesGuard } from './guards/roles.guard';

export {
  CurrentUser,
  NoPropertyContext,
  PropertyId,
  Public,
  Roles,
} from './guards/decorators';

export type {
  AccessTokenPayload,
  AuthenticatedUser,
  PropertyRole,
  RefreshTokenPayload,
  RequestContext,
} from './domain/tokens';
