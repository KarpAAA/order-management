import { Nack, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger } from '@nestjs/common';
import { exchanges, parseMessage, PaymentFailedV1, PaymentSucceededV1 } from '@oms/contracts';

import { TenantContext } from '@common/tenancy/tenant-context';
import { systemActor } from '@shared/auth/actor';
import { InvalidStateError } from '@shared/errors/domain-error';

import { CompleteOrderPaymentService } from '../../application/complete-order-payment.service';
import { FailOrderPaymentService } from '../../application/fail-order-payment.service';

import type { AnyMessage } from '@oms/contracts';

const ACTOR = systemActor('consumer:orders');

/** The queue of the api on the `events` exchange: what payments-service says about a charge. */
const PAYMENT_EVENTS_QUEUE = 'api.payment-events';

/**
 * The answer to `payments.charge-payment`. Thin: validate the message against its contract,
 * bind the tenant from the envelope, build the actor, call one use case.
 * Returning acknowledges the message; `Nack(false)` rejects it without putting it back.
 * A use case that throws is rejected the same way by the connection (rabbit-connection.ts).
 */
@Injectable()
export class PaymentEventsConsumer {
  private readonly logger = new Logger(PaymentEventsConsumer.name);

  constructor(
    private readonly tenant: TenantContext,
    private readonly completePayment: CompleteOrderPaymentService,
    private readonly failPayment: FailOrderPaymentService,
  ) {}

  @RabbitSubscribe({
    exchange: exchanges.events.name,
    routingKey: [PaymentSucceededV1.name, PaymentFailedV1.name],
    queue: PAYMENT_EVENTS_QUEUE,
    queueOptions: { durable: true },
  })
  async onPaymentEvent(raw: unknown): Promise<Nack | undefined> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      // not a contract this build knows: retrying cannot help
      this.logger.error(`rejected a message (${parsed.reason}): ${parsed.detail}`);
      return new Nack(false);
    }
    const { message } = parsed;
    try {
      const handled = await this.tenant.runInWorkspace(message.workspaceId, () =>
        this.settle(message),
      );
      if (handled) return undefined;
    } catch (err: unknown) {
      if (!(err instanceof InvalidStateError)) throw err;
      // Already settled, or a stale attempt: done, not failed (the event came twice or late).
      this.logger.log(`${message.name} ${message.messageId} skipped: ${err.code}`);
      return undefined;
    }
    this.logger.error(`rejected ${message.name}: not an event of this queue`);
    return new Nack(false);
  }

  /** False for a message this queue is not bound to. */
  private async settle(message: AnyMessage): Promise<boolean> {
    const { orderId, paymentAttempt } = message.payload;
    switch (message.name) {
      case PaymentSucceededV1.name:
        await this.completePayment.execute(
          { orderId, paymentAttempt, pspChargeId: message.payload.chargeId },
          ACTOR,
        );
        return true;
      case PaymentFailedV1.name:
        await this.failPayment.execute(
          { orderId, paymentAttempt, reason: message.payload.declineCode },
          ACTOR,
        );
        return true;
      default:
        return false;
    }
  }
}
