import { Inject, Injectable } from '@nestjs/common';

import { CorrelationContext } from '@common/messaging/correlation-context';
import { orderSagaConfig, type OrderSagaConfig } from '@config/configuration';
import { Outbox } from '@infra/outbox/outbox';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';

import { OrderSagaStep } from '../domain/order-saga-step';

import { SAGA_TIMEOUTS_QUEUE, SagaStepTimeoutV1 } from './saga-step-timeout.message';

import type { WaitingStep } from '../domain/order-saga-step';
import type { SagaStepTimeout, SagaTimeoutScheduler } from '../ports/saga-timeout-scheduler.port';

/**
 * Writes the timeout of a saga step to the outbox as a delayed message, in the transaction
 * that begins the step: a step never waits without the message that ends its wait. No Redis
 * and no second write beside the database (docs/adr/0017-order-saga.md).
 *
 * How long a step may wait is configuration, and each value is a delay queue of the broker
 * (`rabbitConfig.delays`): the two lists are built from the same settings.
 */
@Injectable()
export class OutboxSagaTimeoutAdapter implements SagaTimeoutScheduler {
  constructor(
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly correlation: CorrelationContext,
    @Inject(orderSagaConfig.KEY) private readonly config: OrderSagaConfig,
  ) {}

  async schedule(timeout: SagaStepTimeout): Promise<Date> {
    const now = this.clock.now();
    const delayMs = this.delayOf(timeout.step);
    const message = SagaStepTimeoutV1.create(
      {
        messageId: newId(),
        occurredAt: now,
        workspaceId: timeout.workspaceId,
        // what the saga sends on a timeout belongs to the chain that began the step
        correlationId: this.correlation.id(),
      },
      { orderId: timeout.orderId, attempt: timeout.attempt, step: timeout.step },
    );

    await this.outbox.appendDelayed({ queue: SAGA_TIMEOUTS_QUEUE, delayMs, message });
    // The wait starts when the broker takes the message, a moment after this: the timeout
    // goes off at this deadline or later, never before it.
    return new Date(now.getTime() + delayMs);
  }

  private delayOf(step: WaitingStep): number {
    switch (step) {
      case OrderSagaStep.Reserving:
        return this.config.reserveTimeoutMs;
      case OrderSagaStep.Charging:
        return this.config.chargeTimeoutMs;
      case OrderSagaStep.CancellingPayment:
      case OrderSagaStep.Releasing:
        return this.config.compensationTimeoutMs;
    }
  }
}
