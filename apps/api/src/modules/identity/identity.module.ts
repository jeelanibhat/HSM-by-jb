import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './application/auth.service';
import { AuthResolver } from './graphql/auth.resolver';
import { PasswordService } from './infra/password.service';
import { SessionStore } from './infra/session-store';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PropertyContextGuard } from './guards/property-context.guard';
import { RolesGuard } from './guards/roles.guard';

/**
 * Secrets are passed per sign/verify call in AuthService rather than registered on
 * JwtModule, because access and refresh tokens are signed with DIFFERENT secrets.
 * A single module-level secret would let a refresh token verify as an access one.
 */
@Module({
  imports: [JwtModule.register({})],
  providers: [
    AuthService,
    PasswordService,
    SessionStore,
    AuthResolver,

    /**
     * The global guards are registered HERE, not in AppModule.
     *
     * An APP_GUARD is instantiated in the injector of the module that declares it.
     * Declared in AppModule, JwtAuthGuard could not resolve JwtService — that
     * provider lives in this module's JwtModule import. Nest applies the guard
     * app-wide either way, so the module that owns auth is the right home for it.
     *
     * Order matters: authenticate → resolve tenant → check role. RolesGuard reads
     * req.role, which PropertyContextGuard sets, which needs req.user from
     * JwtAuthGuard.
     */
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PropertyContextGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService, PasswordService],
})
export class IdentityModule {}
