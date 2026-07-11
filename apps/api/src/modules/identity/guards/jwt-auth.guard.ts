import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Env } from '../../../config/env';
import type { AccessTokenPayload } from '../domain/tokens';
import { IS_PUBLIC_KEY } from './decorators';

/**
 * Authentication. Registered GLOBALLY, so every resolver is protected unless it
 * explicitly opts out with @Public(). A new resolver added by a developer who
 * forgets to think about auth is locked by default.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = GqlExecutionContext.create(context).getContext().req;

    const header: string | undefined = req?.headers?.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice('Bearer '.length);

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    /**
     * A refresh token must never authenticate a request. Both are signed JWTs; if
     * we didn't check `typ`, the long-lived refresh token — which sits in a cookie
     * and gets sent on every request — would work as a 7-day access token.
     */
    if (payload.typ !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }

    req.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      roles: payload.roles ?? [],
    };

    return true;
  }
}
