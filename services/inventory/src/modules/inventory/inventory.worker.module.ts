// transport · worker
import { Module } from '@nestjs/common';

import { InventoryConsumer } from './interface/worker/inventory.consumer';
import { InventoryModule } from './inventory.module';

@Module({
  imports: [InventoryModule],
  providers: [InventoryConsumer],
})
export class InventoryWorkerModule {}
