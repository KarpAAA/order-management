import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { ChargePaymentV1, exchanges } from '@oms/contracts';

import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';

import type {
  PaymentChargeScheduler,
  ScheduledCharge,
} from '../ports/payment-charge-scheduler.port';

/**
 * Sends the command `payments.charge-payment` to the `commands` exchange; the routing key is
 * the name of the command, and payments-service binds its queue with it.
 *
 * The idempotency key `<orderId>:<attempt>` is chosen here and travels to the provider
 * unchanged: a command delivered twice, or an attempt charged twice, is one charge.
 */
@Injectable()
export class RabbitPaymentChargeAdapter implements PaymentChargeScheduler {
  constructor(
    private readonly amqp: AmqpConnection,
    private readonly clock: Clock,
  ) {}

  async schedule(charge: ScheduledCharge): Promise<void> {
    const message = ChargePaymentV1.create(
      {
        messageId: newId(),
        occurredAt: this.clock.now(),
        workspaceId: charge.workspaceId,
        // Starts the chain: the answer of payments carries it back. The id of the HTTP request
        // takes its place when requests get one (Step 4).
        correlationId: newId(),
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

    await this.amqp.publish(exchanges.commands.name, message.name, message, {
      messageId: message.messageId,
      correlationId: message.correlationId,
    });
  }
}
