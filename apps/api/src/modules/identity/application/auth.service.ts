import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@hotelos/domain';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Env } from '../../../config/env';
import { DB, type Database } from '../../../db/db.module';
import { TenantTransaction } from '../../../db/tenant-transaction';
import { roles, userPropertyRoles, users } from '../infra/schema';
import { PasswordService } from '../infra/password.service';
import { SessionStore } from '../infra/session-store';
import type {
  AccessTokenPayload,
  AuthenticatedUser,
  PropertyRole,
  RefreshTokenPayload,
} from '../domain/tokens';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly tx: TenantTransaction,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionStore,
  ) {}

  /**
   * Log in.
   *
   * Every failure path returns the SAME error and burns the same CPU. "No such
   * user", "wrong password" and "account disabled" are indistinguishable to a
   * caller — otherwise the login form becomes an account-enumeration oracle.
   */
  async login(email: string, password: string): Promise<TokenPair> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      // Spend the same ~50ms an argon2 verify would, so timing reveals nothing.
      await this.passwords.fakeVerify();
      throw new UnauthorizedException('Invalid email or password');
    }

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid email or password');
    }

    const propertyRoles = await this.loadRoles(user.id);

    return this.issueTokens(
      { id: user.id, email: user.email, name: user.name, roles: propertyRoles },
      uuidv7(), // new login = new token family
    );
  }

  /**
   * Exchange a refresh token for a new pair, rotating it.
   *
   * A token that verifies but is no longer the family's live one has been spent
   * already — replay or theft. We cannot distinguish, so SessionStore.rotate()
   * revokes the whole family and we reject. The legitimate user re-logs in; the
   * attacker's stolen token is now worthless.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // An access token presented at the refresh endpoint must not work. Without
    // this check, a token leaked from a browser could be upgraded into a session.
    if (payload.typ !== 'refresh') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const nextJti = uuidv7();
    const outcome = await this.sessions.rotate(
      payload.sub,
      payload.fam,
      payload.jti,
      nextJti,
      this.refreshTtlSeconds(),
    );

    if (outcome !== 'rotated') {
      // 'reuse'   → family already revoked by rotate(); everyone is logged out.
      // 'unknown' → family expired or was revoked (logout / password change).
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    const [user] = await this.db.select().from(users).where(eq(users.id, payload.sub)).limit(1);

    // Disabled between refreshes? The live session dies now, not in 15 minutes.
    if (!user || user.status !== 'ACTIVE') {
      await this.sessions.revokeAllForUser(payload.sub);
      throw new UnauthorizedException('Session expired. Please sign in again.');
    }

    const propertyRoles = await this.loadRoles(user.id);

    return this.issueTokens(
      { id: user.id, email: user.email, name: user.name, roles: propertyRoles },
      payload.fam,
      nextJti, // rotate() already committed this jti as the live one
    );
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;

    try {
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      });
      await this.sessions.revokeFamily(payload.sub, payload.fam);
    } catch {
      // Logging out with a junk token is not an error worth surfacing.
    }
  }

  /**
   * Roles are read fresh from the DB on every login and refresh, never trusted
   * from the incoming token. A manager demoted to front desk loses cashiering
   * within one access-token lifetime (15 min), not at their next login.
   *
   * Runs USER-scoped, not property-scoped: we are asking "where may this person
   * work?", which is the question that must be answered before a property exists.
   * The role_visibility policy (migration 0003) reads app.user_id to allow it.
   */
  private async loadRoles(userId: string): Promise<PropertyRole[]> {
    const rows = await this.tx.runAsUser(userId, (tx) =>
      tx
        .select({ propertyId: userPropertyRoles.propertyId, code: roles.code })
        .from(userPropertyRoles)
        .innerJoin(roles, eq(roles.id, userPropertyRoles.roleId))
        .where(eq(userPropertyRoles.userId, userId)),
    );

    return rows.map((r) => ({ propertyId: r.propertyId, role: r.code as Role }));
  }

  private async issueTokens(
    user: AuthenticatedUser,
    familyId: string,
    existingJti?: string,
  ): Promise<TokenPair> {
    const jti = existingJti ?? uuidv7();

    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      roles: user.roles,
      typ: 'access',
    };

    const refreshPayload: RefreshTokenPayload = {
      sub: user.id,
      jti,
      fam: familyId,
      typ: 'refresh',
    };

    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
    });

    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }),
    });

    // Fresh login: register the family. Rotation already updated it.
    if (!existingJti) {
      await this.sessions.startFamily(user.id, familyId, jti, this.refreshTtlSeconds());
    }

    return { accessToken, refreshToken, user };
  }

  /** Parse '7d' / '12h' / '30m' / '900s' into seconds for the Valkey TTL. */
  private refreshTtlSeconds(): number {
    const ttl = this.config.get('JWT_REFRESH_TTL', { infer: true });
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) throw new Error(`Unparseable JWT_REFRESH_TTL: ${ttl}`);

    const value = Number(match[1]);
    const unit = match[2] as 's' | 'm' | 'h' | 'd';
    const multiplier = { s: 1, m: 60, h: 3600, d: 86_400 }[unit];

    return value * multiplier;
  }

  /**
   * Grant a user a role at a property. Property-scoped: the role_grant policy's
   * WITH CHECK requires app.property_id to match, so an admin at Alpha physically
   * cannot mint a role at Beta — even with a bug in the calling code.
   */
  async grantRole(userId: string, propertyId: string, role: Role): Promise<void> {
    // identity.roles is global reference data, not under RLS.
    const [roleRow] = await this.db.select().from(roles).where(eq(roles.code, role)).limit(1);
    if (!roleRow) throw new Error(`Unknown role: ${role}`);

    await this.tx.run(propertyId, (tx) =>
      tx
        .insert(userPropertyRoles)
        .values({ userId, propertyId, roleId: roleRow.id })
        .onConflictDoNothing(),
    );
  }

  /** The caller's role at one property. Property-scoped, so RLS backs the WHERE. */
  async findRoleAtProperty(userId: string, propertyId: string): Promise<Role | null> {
    const rows = await this.tx.run(propertyId, (tx) =>
      tx
        .select({ code: roles.code })
        .from(userPropertyRoles)
        .innerJoin(roles, eq(roles.id, userPropertyRoles.roleId))
        .where(
          and(
            eq(userPropertyRoles.userId, userId),
            eq(userPropertyRoles.propertyId, propertyId),
          ),
        )
        .limit(1),
    );

    return (rows[0]?.code as Role) ?? null;
  }
}
