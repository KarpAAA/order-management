// layered · L4 · CQS + EventBus
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { ordersQueueConfig, paymentsConfig } from '@config/configuration';
import type { OrdersQueueConfig, PaymentsConfig } from '@config/configuration';

import { CatalogModule } from '@modules/catalog';
import { IdentityModule } from '@modules/identity';

import { CancelOrderService } from './application/cancel-order.service';
import { CompleteOrderPaymentService } from './application/complete-order-payment.service';
import { CreateOrderService } from './application/create-order.service';
import { FailOrderPaymentService } from './application/fail-order-payment.service';
import { FulfillOrderService } from './application/fulfill-order.service';
import { SchedulePaymentChargeHandler } from './application/handlers/schedule-payment-charge.handler';
import { OrderInputsReader } from './application/order-inputs.reader';
import { OrdersPolicy } from './application/orders.policy';
import { PlaceOrderService } from './application/place-order.service';
import { ProcessOrderPaymentService } from './application/process-order-payment.service';
import { UpdateOrderService } from './application/update-order.service';
import { FakePaymentGateway } from './infrastructure/fake-payment-gateway.adapter';
import { HttpPaymentGateway } from './infrastructure/http-payment-gateway.adapter';
import { ORDERS_QUEUE, OrdersQueue } from './infrastructure/orders.queue';
import { OrdersRepository } from './infrastructure/orders.repository';
import { ORDERS_REPOSITORY } from './ports/orders-repository.port';
import { PAYMENT_CHARGE_SCHEDULER } from './ports/payment-charge-scheduler.port';
import { PAYMENT_GATEWAY } from './ports/payment-gateway.port';
import { OrdersQueryService } from './read/orders.query.service';

export { ORDERS_QUEUE };

const USE_CASES = [
  CreateOrderService,
  UpdateOrderService,
  PlaceOrderService,
  CancelOrderService,
  FulfillOrderService,
  ProcessOrderPaymentService,
  CompleteOrderPaymentService,
  FailOrderPaymentService,
];

@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    // producer only: the @Processor lives in orders.worker.module.ts
    BullModule.registerQueueAsync({
      name: ORDERS_QUEUE,
      inject: [ordersQueueConfig.KEY],
      useFactory: (config: OrdersQueueConfig) => ({
        defaultJobOptions: {
          attempts: config.chargeAttempts,
          backoff: { type: 'exponential', delay: config.chargeBackoffMs },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      }),
    }),
  ],
  providers: [
    // write
    ...USE_CASES,
    OrdersPolicy,
    OrderInputsReader,
    SchedulePaymentChargeHandler,
    { provide: ORDERS_REPOSITORY, useClass: OrdersRepository },
    { provide: PAYMENT_CHARGE_SCHEDULER, useClass: OrdersQueue },
    {
      provide: PAYMENT_GATEWAY,
      inject: [paymentsConfig.KEY, HttpPaymentGateway, FakePaymentGateway],
      useFactory: (config: PaymentsConfig, http: HttpPaymentGateway, fake: FakePaymentGateway) =>
        config.gateway === 'http' ? http : fake,
    },
    HttpPaymentGateway,
    FakePaymentGateway,
    // read
    OrdersQueryService,
  ],
  // No facade yet: no other module consumes orders. Use cases and the query service are
  // exported to orders' own transport modules only.
  exports: [...USE_CASES, OrdersQueryService],
})
export class OrdersModule {}
