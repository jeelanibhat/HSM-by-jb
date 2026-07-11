import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { PropertyResolver } from './graphql/property.resolver';

@Module({
  imports: [IdentityModule],
  providers: [PropertyResolver],
})
export class PropertyModule {}
