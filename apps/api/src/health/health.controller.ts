import { Controller, Get } from '@nestjs/common';
import { Public } from '../modules/identity';

/**
 * Plain HTTP readiness probe.
 *
 * A load balancer cannot POST a GraphQL query, and neither can Playwright's
 * webServer wait-for-url. Deliberately says nothing but "up" — no version, no schema
 * names, no connection strings for an unauthenticated caller to read.
 *
 * The deep check (can we actually reach Postgres?) stays on the GraphQL `health`
 * query. A readiness probe that hits the database on every poll is a readiness probe
 * that takes the database down when the fleet is large enough.
 */
@Controller()
export class HealthController {
  @Public()
  @Get('healthz')
  healthz(): { status: string } {
    return { status: 'ok' };
  }
}
