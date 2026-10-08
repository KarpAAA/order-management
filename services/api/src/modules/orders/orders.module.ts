// layered · L4 · CQS + EventBus
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CatalogModule } from '@modules/catalog';
import { IdentityModule } from '@modules/identity';

import { CancelOrderService } from './application/cancel-order.service';
import { CompleteOrderPaymentService } from './application/complete-order-payment.service';
import { CreateOrderService } from './application/create-order.service';
import { FailOrderPaymentService } from './application/fail-order-payment.service';
import { FulfillOrderService } from './application/fulfill-order.service';
import { MaintainOrderEventPartitionsService } from './application/maintain-order-event-partitions.service';
import { OrderInputsReader } from './application/order-inputs.reader';
import { OrdersPolicy } from './application/orders.policy';
import { PlaceOrderService } from './application/place-order.service';
import { UpdateOrderService } from './application/update-order.service';
import { OrderEventsTranslator } from './infrastructure/order-events.translator';
import { ORDERS_QUEUE, OrdersQueue } from './infrastructure/orders.queue';
import { OrdersRepository } from './infrastructure/orders.repository';
import { OutboxPaymentChargeAdapter } from './infrastructure/outbox-payment-charge.adapter';
import { PostgresOrderEventPartitions } from './infrastructure/postgres-order-event-partitions.adapter';
import { ORDER_EVENT_PARTITIONS } from './ports/order-event-partitions.port';
import { ORDERS_REPOSITORY } from './ports/orders-repository.port';
import { PAYMENT_CHARGE_SCHEDULER } from './ports/payment-charge-scheduler.port';
import { OrdersQueryService } from './read/orders.query.service';

export { ORDERS_QUEUE };

const USE_CASES = [
  CreateOrderService,
  UpdateOrderService,
  PlaceOrderService,
  CancelOrderService,
  FulfillOrderService,
  CompleteOrderPaymentService,
  FailOrderPaymentService,
  MaintainOrderEventPartitionsService,
];

@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    // producer only: the @Processor lives in orders.worker.module.ts
    BullModule.registerQueue({
      name: ORDERS_QUEUE,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    }),
  ],
  providers: [
    // write
    ...USE_CASES,
    OrdersPolicy,
    OrderInputsReader,
    { provide: ORDERS_REPOSITORY, useClass: OrdersRepository },
    OrdersQueue,
    // the charge itself happens in payments-service: the command is a row of the outbox
    { provide: PAYMENT_CHARGE_SCHEDULER, useClass: OutboxPaymentChargeAdapter },
    // what the reliable events of orders become on the broker
    OrderEventsTranslator,
    { provide: ORDER_EVENT_PARTITIONS, useClass: PostgresOrderEventPartitions },
    // read
    OrdersQueryService,
  ],
  // No facade yet: no other module consumes orders. Use cases, the query service and the queue
  // producer (the worker module registers the cron schedule on it) are exported to orders' own
  // transport modules only.
  exports: [...USE_CASES, OrdersQueryService, OrdersQueue],
})
export class OrdersModule {}
