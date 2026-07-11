import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity';
import { InventoryService } from './application/inventory.service';
import { InventoryResolver } from './graphql/inventory.resolver';

@Module({
  imports: [IdentityModule],
  providers: [InventoryService, InventoryResolver],
  exports: [InventoryService],
})
export class InventoryModule {}
