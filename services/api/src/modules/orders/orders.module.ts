// layered · L4 · CQS + EventBus
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { CatalogModule } from '@modules/catalog';
import { IdentityModule } from '@modules/identity';

import { CancelOrderService } from './application/cancel-order.service';
import { CompleteOrderPaymentService } from './application/complete-order-payment.service';
import { ConfirmStockReleaseService } from './application/confirm-stock-release.service';
import { ConfirmStockReservationService } from './application/confirm-stock-reservation.service';
import { CreateOrderService } from './application/create-order.service';
import { ExpireSagaStepService } from './application/expire-saga-step.service';
import { FailOrderPaymentService } from './application/fail-order-payment.service';
import { FulfillOrderService } from './application/fulfill-order.service';
import { MaintainOrderEventPartitionsService } from './application/maintain-order-event-partitions.service';
import { OrderInputsReader } from './application/order-inputs.reader';
import { OrderSagaSteps } from './application/order-saga-steps';
import { OrdersPolicy } from './application/orders.policy';
import { PlaceOrderService } from './application/place-order.service';
import { RejectStockReservationService } from './application/reject-stock-reservation.service';
import { UpdateOrderService } from './application/update-order.service';
import { OrderEventsTranslator } from './infrastructure/order-events.translator';
import { OrderSagasRepository } from './infrastructure/order-sagas.repository';
import { ORDERS_QUEUE, OrdersQueue } from './infrastructure/orders.queue';
import { OrdersRepository } from './infrastructure/orders.repository';
import { OutboxPaymentChargeAdapter } from './infrastructure/outbox-payment-charge.adapter';
import { OutboxSagaTimeoutAdapter } from './infrastructure/outbox-saga-timeout.adapter';
import { OutboxStockReservationAdapter } from './infrastructure/outbox-stock-reservation.adapter';
import { PostgresOrderEventPartitions } from './infrastructure/postgres-order-event-partitions.adapter';
import { ORDER_EVENT_PARTITIONS } from './ports/order-event-partitions.port';
import { ORDER_SAGAS_REPOSITORY } from './ports/order-sagas-repository.port';
import { ORDERS_REPOSITORY } from './ports/orders-repository.port';
import { PAYMENT_CHARGE_SCHEDULER } from './ports/payment-charge-scheduler.port';
import { SAGA_TIMEOUT_SCHEDULER } from './ports/saga-timeout-scheduler.port';
import { STOCK_RESERVATION_SCHEDULER } from './ports/stock-reservation-scheduler.port';
import { OrdersQueryService } from './read/orders.query.service';

export { ORDERS_QUEUE };

const USE_CASES = [
  CreateOrderService,
  UpdateOrderService,
  PlaceOrderService,
  CancelOrderService,
  FulfillOrderService,
  // the steps of the saga an answer or a timeout decides (docs/adr/0017-order-saga.md)
  ConfirmStockReservationService,
  RejectStockReservationService,
  CompleteOrderPaymentService,
  FailOrderPaymentService,
  ConfirmStockReleaseService,
  ExpireSagaStepService,
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
    OrderSagaSteps,
    { provide: ORDERS_REPOSITORY, useClass: OrdersRepository },
    { provide: ORDER_SAGAS_REPOSITORY, useClass: OrderSagasRepository },
    OrdersQueue,
    // what the saga asks of the other services, and of itself for later: rows of the outbox
    { provide: STOCK_RESERVATION_SCHEDULER, useClass: OutboxStockReservationAdapter },
    { provide: PAYMENT_CHARGE_SCHEDULER, useClass: OutboxPaymentChargeAdapter },
    { provide: SAGA_TIMEOUT_SCHEDULER, useClass: OutboxSagaTimeoutAdapter },
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
