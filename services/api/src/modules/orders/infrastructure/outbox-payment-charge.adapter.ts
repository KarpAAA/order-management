import { Injectable } from '@nestjs/common';
import { ChargePaymentV1, exchanges } from '@oms/contracts';

import { CorrelationContext } from '@common/messaging/correlation-context';
import { Outbox } from '@infra/outbox/outbox';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';

import type {
  PaymentChargeScheduler,
  ScheduledCharge,
} from '../ports/payment-charge-scheduler.port';

/**
 * Writes the command `payments.charge-payment` to the outbox, in the transaction of the use
 * case that calls it: the order is PENDING_PAYMENT and the command exists, or neither. The
 * relay of the worker publishes it to the `commands` exchange; the routing key is the name of
 * the command, and payments-service binds its queue with it.
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
    const message = ChargePaymentV1.create(
      {
        messageId: newId(),
        occurredAt: this.clock.now(),
        workspaceId: charge.workspaceId,
        // the answer of payments carries it back
        correlationId: this.correlation.id(),
      },
      {
        orderId: charge.orderId,
        paymentAttempt: charge.paymentAttempt,
        // a JSON number on the wire, as in the HTTP API; the contract refuses an unsafe one
        amount: {
          amountMinor: Number(charge.amount.amountMinor),
          currency: charge.amount.currency,
        },
        idempotencyKey: `${charge.orderId}:${charge.paymentAttempt}`,
      },
    );

    await this.outbox.append({ exchange: exchanges.commands.name, message });
  }
}
