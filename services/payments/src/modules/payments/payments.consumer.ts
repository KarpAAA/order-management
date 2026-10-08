import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { CancelPaymentV1, ChargePaymentV1, exchanges, parseMessage } from '@oms/contracts';

import { systemActor } from '@shared/auth/actor';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import type { Delivery } from '@shared/messaging/delivery';

import { CancelPaymentService } from './cancel-payment.service';
import { ChargePaymentService } from './charge-payment.service';

const ACTOR = systemActor('consumer:payments');

/** The queue of this service: every command addressed to payments lands here. */
const PAYMENTS_COMMANDS_QUEUE = 'payments.commands';

/**
 * Thin: validate the message against its contract, build the actor, call one use case. The
 * use case records the message in its inbox, in the transaction that settles the payment.
 * Returning acknowledges the message. Whatever is thrown is settled by the connection
 * (infrastructure/messaging/retry-or-park.ts): delivered again after a delay, or parked in
 * `payments.commands.dlq` when it is an `UnprocessableMessageError` or the last delivery.
 */
@Injectable()
export class PaymentsConsumer {
  constructor(
    private readonly chargePayment: ChargePaymentService,
    private readonly cancelPayment: CancelPaymentService,
  ) {}

  // the queue's arguments and its retry policy are added by RabbitSubscribers, from the config
  @RabbitSubscribe({
    exchange: exchanges.commands.name,
    routingKey: [ChargePaymentV1.name, CancelPaymentV1.name],
    queue: PAYMENTS_COMMANDS_QUEUE,
  })
  async onCommand(raw: unknown, delivery: Delivery): Promise<void> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      // not a contract this build knows: another delivery cannot help
      throw new UnprocessableMessageError(`${parsed.reason}: ${parsed.detail}`);
    }
    const { message } = parsed;
    const envelope = {
      messageId: message.messageId,
      queue: PAYMENTS_COMMANDS_QUEUE,
      workspaceId: message.workspaceId,
      correlationId: message.correlationId,
    };

    switch (message.name) {
      case ChargePaymentV1.name: {
        const { orderId, paymentAttempt, amount, idempotencyKey, expiresAt } = message.payload;
        await this.chargePayment.execute(
          {
            ...envelope,
            orderId,
            paymentAttempt,
            amount: { amountMinor: BigInt(amount.amountMinor), currency: amount.currency },
            idempotencyKey,
            expiresAt: expiresAt === undefined ? null : new Date(expiresAt),
            lastDelivery: delivery.last,
          },
          ACTOR,
        );
        return;
      }
      case CancelPaymentV1.name: {
        const { orderId, paymentAttempt } = message.payload;
        await this.cancelPayment.execute({ ...envelope, orderId, paymentAttempt }, ACTOR);
        return;
      }
      default:
        throw new UnprocessableMessageError(`${message.name} is not a command of this queue`);
    }
  }
}
