import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Env } from './config/env';
import { validateEnv } from './config/env';
import { DbModule } from './db/db.module';
import { depthLimit } from './graphql/depth-limit';
import { HealthModule } from './health/health.module';
import { ValkeyModule } from './valkey/valkey.module';
import { IdentityModule } from './modules/identity';
import { PropertyModule } from './modules/property';

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
      useFactory: (config: ConfigService<Env, true>) => {
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

          context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
        };
      },
    }),

    DbModule,
    ValkeyModule,
    HealthModule,
    IdentityModule,
    PropertyModule,
  ],
  // The global auth/tenancy/RBAC guards are registered inside IdentityModule —
  // they need JwtService, which lives there. They still apply app-wide, so every
  // resolver is protected unless it opts out with @Public(). Fail closed.
})
export class AppModule {}
