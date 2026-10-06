import { Nack, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger } from '@nestjs/common';
import { ChargePaymentV1, exchanges, parseMessage } from '@oms/contracts';

import { systemActor } from '@shared/auth/actor';

import { ChargePaymentService } from './charge-payment.service';

const ACTOR = systemActor('consumer:payments');

/** The queue of this service: every command addressed to payments lands here. */
const PAYMENTS_COMMANDS_QUEUE = 'payments.commands';

/**
 * Thin: validate the message against its contract, build the actor, call one use case.
 * Returning acknowledges the message; `Nack(false)` rejects it without putting it back.
 * A use case that throws is rejected the same way by the connection (rabbit-connection.ts).
 */
@Injectable()
export class PaymentsConsumer {
  private readonly logger = new Logger(PaymentsConsumer.name);

  constructor(private readonly chargePayment: ChargePaymentService) {}

  @RabbitSubscribe({
    exchange: exchanges.commands.name,
    routingKey: ChargePaymentV1.name,
    queue: PAYMENTS_COMMANDS_QUEUE,
    queueOptions: { durable: true },
  })
  async onCommand(raw: unknown): Promise<Nack | undefined> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      // not a contract this build knows: retrying cannot help
      this.logger.error(`rejected a message (${parsed.reason}): ${parsed.detail}`);
      return new Nack(false);
    }
    const { message } = parsed;
    if (message.name !== ChargePaymentV1.name) {
      this.logger.error(`rejected ${message.name}: not a command of this queue`);
      return new Nack(false);
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
      },
      ACTOR,
    );
    return undefined;
  }
}
