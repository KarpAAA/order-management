import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { ChargePaymentV1, exchanges, parseMessage } from '@oms/contracts';

import { systemActor } from '@shared/auth/actor';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import type { Delivery } from '@shared/messaging/delivery';

import { ChargePaymentService } from './charge-payment.service';

const ACTOR = systemActor('consumer:payments');

/** The queue of this service: every command addressed to payments lands here. */
const PAYMENTS_COMMANDS_QUEUE = 'payments.commands';

/**
 * Thin: validate the message against its contract, build the actor, call one use case.
 * Returning acknowledges the message. Whatever is thrown is settled by the connection
 * (infrastructure/messaging/retry-or-park.ts): delivered again after a delay, or parked in
 * `payments.commands.dlq` when it is an `UnprocessableMessageError` or the last delivery.
 */
@Injectable()
export class PaymentsConsumer {
  constructor(private readonly chargePayment: ChargePaymentService) {}

  // the queue's arguments and its retry policy are added by RabbitSubscribers, from the config
  @RabbitSubscribe({
    exchange: exchanges.commands.name,
    routingKey: ChargePaymentV1.name,
    queue: PAYMENTS_COMMANDS_QUEUE,
  })
  async onCommand(raw: unknown, delivery: Delivery): Promise<void> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      // not a contract this build knows: another delivery cannot help
      throw new UnprocessableMessageError(`${parsed.reason}: ${parsed.detail}`);
    }
    const { message } = parsed;
    if (message.name !== ChargePaymentV1.name) {
      throw new UnprocessableMessageError(`${message.name} is not a command of this queue`);
    }

    const { orderId, paymentAttempt, amount, idempotencyKey } = message.payload;
    await this.chargePayment.execute(
      {
        workspaceId: message.workspaceId,
        orderId,
        paymentAttempt,
        amount: { amountMinor: BigInt(amount.amountMinor), currency: amount.currency },
        idempotencyKey,
        correlationId: message.correlationId,
        lastDelivery: delivery.last,
      },
      ACTOR,
    );
  }
}
