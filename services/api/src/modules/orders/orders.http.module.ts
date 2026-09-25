// transport · http
import { Module } from '@nestjs/common';

import { IdentityModule } from '@modules/identity';

import { OrdersController } from './interface/http/orders.controller';
import { OrdersModule } from './orders.module';

@Module({
  // IdentityModule provides MEMBERSHIP_READER to the workspace access guard
  imports: [OrdersModule, IdentityModule],
  controllers: [OrdersController],
})
export class OrdersHttpModule {}
