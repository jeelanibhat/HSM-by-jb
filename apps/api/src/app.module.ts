import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtService } from '@nestjs/jwt';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Env } from './config/env';
import { validateEnv } from './config/env';
import { DbModule } from './db/db.module';
import { depthLimit } from './graphql/depth-limit';
import { HealthModule } from './health/health.module';
import { ValkeyModule } from './valkey/valkey.module';
import { SharedModule } from './shared';
import { IdentityModule } from './modules/identity';
import type { AccessTokenPayload } from './modules/identity';
import { PropertyModule } from './modules/property';
import { InventoryModule } from './modules/inventory';
import { ReservationsModule } from './modules/reservations';
import { GuestsModule } from './modules/guests';
import { FolioModule } from './modules/folio';
import { NightAuditModule } from './modules/night-audit';
import { HousekeepingModule } from './modules/housekeeping';
import { PosModule } from './modules/pos';
import { ReportingModule } from './modules/reporting';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env', '../../.env'],
    }),

    /**
     * Structured JSON logs with property_id / user_id / request_id on every line
     * (TDD §10). Guest PII must never reach the log stream, so we redact the
     * usual suspects at the transport, not at each call site.
     */
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'req.body.variables.input.password',
              'req.body.variables.password',
              '*.password',
              '*.passwordHash',
              '*.idNumber',
              '*.cardNumber',
            ],
            censor: '[redacted]',
          },
          // Health checks would otherwise drown the log.
          autoLogging: {
            ignore: (req) => req.url === '/healthz',
          },
        },
      }),
    }),

    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Omit<ApolloDriverConfig, 'driver'> => {
        const isProd = config.get('NODE_ENV', { infer: true }) === 'production';

        return {
          // Code-first: NestJS decorators generate the SDL, which we publish to
          // packages/graphql for the frontend's codegen (TDD §5).
          autoSchemaFile: join(process.cwd(), '../../packages/graphql/schema.graphql'),
          sortSchema: true,

          playground: false,
          introspection: config.get('GRAPHQL_INTROSPECTION', { infer: true }),

          validationRules: [depthLimit(config.get('GRAPHQL_DEPTH_LIMIT', { infer: true }))],

          // Never leak a stack trace or a SQL fragment to a client. Expected
          // domain failures travel as `userErrors` in the payload (TDD §5.1);
          // anything reaching here is a bug and is logged, not exposed.
          formatError: (formattedError) => {
            if (!isProd) return formattedError;

            const code = formattedError.extensions?.['code'];
            const safe = code === 'BAD_USER_INPUT' || code === 'QUERY_TOO_DEEP';

            return safe
              ? { message: formattedError.message, extensions: { code } }
              : { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR' } };
          },

          /**
           * WebSocket subscriptions (TDD §5).
           *
           * The HTTP guards cannot run here — there is no request to hang them off.
           * So the socket authenticates ONCE, at the handshake, and the verified
           * user is pinned to the connection context. Every subscription resolver
           * then re-checks the requested propertyId against that user's role claims
           * (see TapeChartResolver), because otherwise any logged-in user could
           * subscribe to any hotel's live feed by passing its id — a
           * WebSocket-shaped hole in the tenancy model.
           *
           * A socket that presents no valid token is refused at connect, not left
           * open and quietly starved.
           */
          subscriptions: {
            'graphql-ws': {
              onConnect: (ctx) => {
                // graphql-ws types `extra` as unknown; it is the per-socket bag we
                // pin the authenticated user to.
                const extra = ctx.extra as Record<string, unknown>;

                const raw = ctx.connectionParams?.['authorization'];
                const header = typeof raw === 'string' ? raw : '';

                if (!header.startsWith('Bearer ')) {
                  throw new Error('Missing bearer token');
                }

                const jwt = new JwtService();
                let payload: AccessTokenPayload;

                try {
                  payload = jwt.verify<AccessTokenPayload>(header.slice('Bearer '.length), {
                    secret: config.get('JWT_ACCESS_SECRET', { infer: true }),
                  });
                } catch {
                  throw new Error('Invalid or expired token');
                }

                // A refresh token must not open a socket, exactly as it must not
                // authenticate an HTTP request.
                if (payload.typ !== 'access') {
                  throw new Error('Invalid token type');
                }

                extra['user'] = {
                  id: payload.sub,
                  email: payload.email,
                  name: payload.name,
                  roles: payload.roles ?? [],
                };
              },
            },
          },

          context: (ctx: { req?: unknown; res?: unknown; extra?: { user?: unknown } }) => {
            // HTTP requests carry req/res; WS carries `extra` from onConnect.
            if (ctx.extra?.user) return { user: ctx.extra.user };
            return { req: ctx.req, res: ctx.res };
          },
        };
      },
    }),

    DbModule,
    ValkeyModule,
    SharedModule,
    HealthModule,
    IdentityModule,
    PropertyModule,
    InventoryModule,
    GuestsModule,
    FolioModule,
    ReservationsModule,
    NightAuditModule,
    ReportingModule,
    HousekeepingModule,
    PosModule,
  ],
  // The global auth/tenancy/RBAC guards are registered inside IdentityModule —
  // they need JwtService, which lives there. They still apply app-wide, so every
  // resolver is protected unless it opts out with @Public(). Fail closed.
})
export class AppModule {}
