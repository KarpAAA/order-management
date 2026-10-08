import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger } from '@nestjs/common';
import { exchanges, parseMessage, PaymentFailedV1, PaymentSucceededV1 } from '@oms/contracts';

import { TenantContext } from '@common/tenancy/tenant-context';
import { systemActor } from '@shared/auth/actor';
import { ConflictError, DomainError, InvalidStateError } from '@shared/errors/domain-error';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';

import { CompleteOrderPaymentService } from '../../application/complete-order-payment.service';
import { FailOrderPaymentService } from '../../application/fail-order-payment.service';

import type { AnyMessage } from '@oms/contracts';

const ACTOR = systemActor('consumer:orders');

/** The queue of the api on the `events` exchange: what payments-service says about a charge. */
const PAYMENT_EVENTS_QUEUE = 'api.payment-events';

/**
 * The answer to `payments.charge-payment`. Thin: validate the message against its contract,
 * bind the tenant from the envelope, build the actor, call one use case.
 * Returning acknowledges the message. Whatever is thrown is settled by the connection
 * (infrastructure/messaging/retry-or-park.ts): delivered again after a delay, or parked in
 * `api.payment-events.dlq` when it is an `UnprocessableMessageError` or the last delivery.
 */
@Injectable()
export class PaymentEventsConsumer {
  private readonly logger = new Logger(PaymentEventsConsumer.name);

  constructor(
    private readonly tenant: TenantContext,
    private readonly completePayment: CompleteOrderPaymentService,
    private readonly failPayment: FailOrderPaymentService,
  ) {}

  // the queue's arguments and its retry policy are added by RabbitSubscribers, from the config
  @RabbitSubscribe({
    exchange: exchanges.events.name,
    routingKey: [PaymentSucceededV1.name, PaymentFailedV1.name],
    queue: PAYMENT_EVENTS_QUEUE,
  })
  async onPaymentEvent(raw: unknown): Promise<void> {
    const parsed = parseMessage(raw);
    if (!parsed.ok) {
      // not a contract this build knows: another delivery cannot help
      throw new UnprocessableMessageError(`${parsed.reason}: ${parsed.detail}`);
    }
    const { message } = parsed;
    let handled: boolean;
    try {
      handled = await this.tenant.runInWorkspace(message.workspaceId, () => this.settle(message));
    } catch (err: unknown) {
      if (err instanceof InvalidStateError) {
        // Already settled, or a stale attempt: done, not failed (the event came twice or late).
        this.logger.log(`${message.name} ${message.messageId} skipped: ${err.code}`);
        return;
      }
      // A concurrent writer won: the next delivery finds the order as that writer left it.
      // Anything that is not a business answer (the database, a bug) may pass as well.
      if (err instanceof ConflictError || !(err instanceof DomainError)) throw err;
      // Business said no and will say it again: no such order in this workspace.
      throw new UnprocessableMessageError(`${err.code}: ${err.message}`, { cause: err });
    }
    if (!handled) {
      throw new UnprocessableMessageError(`${message.name} is not an event of this queue`);
    }
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
