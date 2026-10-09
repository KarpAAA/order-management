import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  exchanges,
  parseMessage,
  PaymentCancelledV1,
  PaymentFailedV1,
  PaymentSucceededV1,
} from '@oms/contracts';

import { CorrelationContext } from '@common/messaging/correlation-context';
import { TenantContext } from '@common/tenancy/tenant-context';
import { systemActor } from '@shared/auth/actor';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import { INBOX, type Inbox } from '@shared/messaging/inbox';

import { CompleteOrderPaymentService } from '../../application/complete-order-payment.service';
import {
  FailOrderPaymentService,
  PAYMENT_TIMEOUT,
} from '../../application/fail-order-payment.service';

import { handleOnce, type MessageScope } from './handle-once';

import type { AnyMessage } from '@oms/contracts';

const ACTOR = systemActor('consumer:orders');

/** The queue of the api on the `events` exchange: what payments-service says about a charge. */
const PAYMENT_EVENTS_QUEUE = 'api.payment-events';

/**
 * The answers to `payments.charge-payment` and `payments.cancel-payment`. Thin: validate the
 * message against its contract, then `handleOnce()`: the tenant from the envelope, one use
 * case, once per message (docs/adr/0015-idempotent-consumers.md).
 * Returning acknowledges the message. Whatever is thrown is settled by the connection
 * (infrastructure/messaging/retry-or-park.ts): delivered again after a delay, or parked in
 * `api.payment-events.dlq` when it is an `UnprocessableMessageError` or the last delivery.
 */
@Injectable()
export class PaymentEventsConsumer {
  private readonly logger = new Logger(PaymentEventsConsumer.name);

  constructor(
    private readonly tenant: TenantContext,
    private readonly correlation: CorrelationContext,
    @Inject(INBOX) private readonly inbox: Inbox,
    private readonly completePayment: CompleteOrderPaymentService,
    private readonly failPayment: FailOrderPaymentService,
  ) {}

  // the queue's arguments and its retry policy are added by RabbitSubscribers, from the config
  @RabbitSubscribe({
    exchange: exchanges.events.name,
    routingKey: [PaymentSucceededV1.name, PaymentFailedV1.name, PaymentCancelledV1.name],
    queue: PAYMENT_EVENTS_QUEUE,
  })
  async onPaymentEvent(raw: unknown): Promise<void> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      // not a contract this build knows: another delivery cannot help
      throw new UnprocessableMessageError(`${parsed.reason}: ${parsed.detail}`);
    }
    const { message } = parsed;
    await handleOnce(this.scope(), PAYMENT_EVENTS_QUEUE, message, () => this.settle(message));
  }

  private async settle(message: AnyMessage): Promise<void> {
    switch (message.name) {
      case PaymentSucceededV1.name: {
        const { orderId, paymentAttempt, chargeId } = message.payload;
        await this.completePayment.execute(
          { orderId, paymentAttempt, pspChargeId: chargeId },
          ACTOR,
        );
        return;
      }
      case PaymentFailedV1.name: {
        const { orderId, paymentAttempt, declineCode } = message.payload;
        await this.failPayment.execute({ orderId, paymentAttempt, reason: declineCode }, ACTOR);
        return;
      }
      case PaymentCancelledV1.name: {
        // nothing was charged, because the saga asked not to: it had stopped waiting
        const { orderId, paymentAttempt } = message.payload;
        await this.failPayment.execute({ orderId, paymentAttempt, reason: PAYMENT_TIMEOUT }, ACTOR);
        return;
      }
      default:
        throw new UnprocessableMessageError(`${message.name} is not an event of this queue`);
    }
  }

  private scope(): MessageScope {
    return {
      tenant: this.tenant,
      correlation: this.correlation,
      inbox: this.inbox,
      logger: this.logger,
    };
  }
}
