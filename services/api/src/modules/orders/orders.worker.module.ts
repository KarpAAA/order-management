// transport · worker
import { Module } from '@nestjs/common';

import { OrdersConsumer } from './interface/worker/orders.consumer';
import { OrdersModule } from './orders.module';

@Module({
  imports: [OrdersModule],
  providers: [OrdersConsumer],
})
export class OrdersWorkerModule {}
