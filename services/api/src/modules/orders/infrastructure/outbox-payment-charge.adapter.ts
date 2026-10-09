import { Injectable } from '@nestjs/common';
import { CancelPaymentV1, ChargePaymentV1, exchanges } from '@oms/contracts';

import { CorrelationContext } from '@common/messaging/correlation-context';
import { Outbox } from '@infra/outbox/outbox';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';

import type {
  PaymentAttemptRef,
  PaymentChargeScheduler,
  ScheduledCharge,
} from '../ports/payment-charge-scheduler.port';
import type { MessageMeta } from '@oms/contracts';

/**
 * Writes the commands for payments-service to the outbox, in the transaction of the use case
 * that calls it: the saga is in its step and the command exists, or neither. The relay of the
 * worker publishes them to the `commands` exchange; the routing key is the name of the
 * command, and payments-service binds its queue with it.
 *
 * The idempotency key `<orderId>:<attempt>` is chosen here and travels to the provider
 * unchanged: a command delivered twice, or an attempt charged twice, is one charge.
 */
@Injectable()
export class OutboxPaymentChargeAdapter implements PaymentChargeScheduler {
  constructor(
    private readonly outbox: Outbox,
    private readonly clock: Clock,
    private readonly correlation: CorrelationContext,
  ) {}

  async schedule(charge: ScheduledCharge): Promise<void> {
    const message = ChargePaymentV1.create(this.meta(charge.workspaceId), {
      orderId: charge.orderId,
      paymentAttempt: charge.paymentAttempt,
      // a JSON number on the wire, as in the HTTP API; the contract refuses an unsafe one
      amount: {
        amountMinor: Number(charge.amount.amountMinor),
        currency: charge.amount.currency,
      },
      idempotencyKey: `${charge.orderId}:${charge.paymentAttempt}`,
      // the saga stops waiting then: a command handled later must charge nothing
      expiresAt: charge.expiresAt.toISOString(),
    });

    await this.outbox.append({ exchange: exchanges.commands.name, message });
  }

  async cancel(attempt: PaymentAttemptRef): Promise<void> {
    const message = CancelPaymentV1.create(this.meta(attempt.workspaceId), {
      orderId: attempt.orderId,
      paymentAttempt: attempt.paymentAttempt,
    });

    await this.outbox.append({ exchange: exchanges.commands.name, message });
  }

  private meta(workspaceId: string): MessageMeta {
    return {
      messageId: newId(),
      occurredAt: this.clock.now(),
      workspaceId,
      // the answer of payments carries it back
      correlationId: this.correlation.id(),
    };
  }
}
