import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService<Env, true>);
  const isProd = config.get('NODE_ENV', { infer: true }) === 'production';

  app.use(
    helmet({
      // Apollo's landing page is disabled anyway; CSP here protects /graphql
      // from being framed or from inline-script injection via error messages.
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // The web app sends the refresh token as an httpOnly cookie (TDD §3), so the
  // origin must be explicit and credentials allowed — a wildcard would be
  // rejected by the browser and would be wrong anyway.
  app.enableCors({
    origin: config.get('CORS_ORIGIN', { infer: true }).split(','),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Property-Id', 'X-Request-Id'],
  });

  // Deliberately NO class-validator ValidationPipe. Input validation is zod,
  // shared with the web app's forms from @hotelos/domain (TDD §7.1) — one schema,
  // one set of rules, applied at the resolver boundary. Adding class-validator
  // would mean two validation stacks that can disagree.

  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
}

void bootstrap();
