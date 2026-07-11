import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { loginSchema } from '@hotelos/domain';
import type { Request, Response } from 'express';
import type { Env } from '../../../config/env';
import { AuthService } from '../application/auth.service';
import { CurrentUser, NoPropertyContext, Public } from '../guards/decorators';
import type { AuthenticatedUser } from '../domain/tokens';
import { AuthPayload, LoginInput, UserType } from './auth.types';

const REFRESH_COOKIE = 'hotelos_rt';

@Resolver()
export class AuthResolver {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @Mutation(() => AuthPayload)
  async login(
    @Args('input') input: LoginInput,
    @Context() ctx: { res: Response },
  ): Promise<AuthPayload> {
    // Zod validates at the boundary — the same schema the web login form uses.
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Invalid input');
    }

    const { accessToken, refreshToken, user } = await this.auth.login(
      parsed.data.email,
      parsed.data.password,
    );

    this.setRefreshCookie(ctx.res, refreshToken);

    return { accessToken, user };
  }

  /**
   * Silent refresh. The client sends no argument — the refresh token rides along
   * in the httpOnly cookie, which is precisely why the client cannot leak it.
   */
  @Public()
  @Mutation(() => AuthPayload)
  async refreshToken(
    @Context() ctx: { req: Request; res: Response },
  ): Promise<AuthPayload> {
    const token = ctx.req.cookies?.[REFRESH_COOKIE];

    const { accessToken, refreshToken, user } = await this.auth.refresh(token);

    this.setRefreshCookie(ctx.res, refreshToken);

    return { accessToken, user };
  }

  @Public()
  @Mutation(() => Boolean)
  async logout(@Context() ctx: { req: Request; res: Response }): Promise<boolean> {
    await this.auth.logout(ctx.req.cookies?.[REFRESH_COOKIE]);
    ctx.res.clearCookie(REFRESH_COOKIE, this.cookieOptions());
    return true;
  }

  /** Who am I, and where can I work? Not scoped to one property by definition. */
  @NoPropertyContext()
  @Query(() => UserType)
  me(@CurrentUser() user: AuthenticatedUser): UserType {
    return user;
  }

  private setRefreshCookie(res: Response, token: string): void {
    res.cookie(REFRESH_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: this.refreshTtlMs(),
    });
  }

  private cookieOptions() {
    const isProd = this.config.get('NODE_ENV', { infer: true }) === 'production';

    return {
      /** JS cannot read it. An XSS payload cannot steal the session. */
      httpOnly: true,

      /** HTTPS only in production; plain HTTP in dev or the cookie never sets. */
      secure: isProd,

      /**
       * 'lax' blocks the cookie on cross-site POSTs, which is what a CSRF attack
       * against /graphql would be. 'none' would require an explicit CSRF token.
       */
      sameSite: 'lax' as const,

      /** Scoped to the refresh path only — it is not sent with every API call. */
      path: '/graphql',
    };
  }

  private refreshTtlMs(): number {
    const ttl = this.config.get('JWT_REFRESH_TTL', { infer: true });
    const match = /^(\d+)([smhd])$/.exec(ttl);
    if (!match) throw new Error(`Unparseable JWT_REFRESH_TTL: ${ttl}`);

    const unit = match[2] as 's' | 'm' | 'h' | 'd';
    return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[unit] * 1000;
  }
}
