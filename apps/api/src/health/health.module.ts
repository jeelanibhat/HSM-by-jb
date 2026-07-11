import { Module } from '@nestjs/common';
import { HealthResolver } from './health.resolver.js';

@Module({
  providers: [HealthResolver],
})
export class HealthModule {}
