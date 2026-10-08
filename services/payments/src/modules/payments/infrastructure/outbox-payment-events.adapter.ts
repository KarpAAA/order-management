import { Injectable } from '@nestjs/common';
import { exchanges, PaymentFailedV1, PaymentSucceededV1 } from '@oms/contracts';

import { Outbox } from '@infra/outbox/outbox';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';

import type {
  PaymentEventsPublisher,
  PaymentOutcome,
} from '../ports/payment-events-publisher.port';
import type { MessageMeta } from '@oms/contracts';

/**
 * Writes the outcome to the outbox as `payments.payment-succeeded` or
 * `payments.payment-failed`, in the transaction that settled the payment: the row says how
 * the attempt ended and the answer exists, or neither. The relay publishes it to the `events`
 * exchange; the routing key is the name of the message, and who reads it is not known here.
 */
@Injectable()
export class OutboxPaymentEventsPublisher implements PaymentEventsPublisher {
  constructor(
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async publish(outcome: PaymentOutcome): Promise<void> {
    const meta: MessageMeta = {
      messageId: newId(),
      occurredAt: this.clock.now(),
      workspaceId: outcome.workspaceId,
      correlationId: outcome.correlationId,
    };
    const attempt = { orderId: outcome.orderId, paymentAttempt: outcome.paymentAttempt };
    const { result } = outcome;
    const message =
      result.status === 'succeeded'
        ? PaymentSucceededV1.create(meta, { ...attempt, chargeId: result.chargeId })
        : PaymentFailedV1.create(meta, {
            ...attempt,
            declineCode: result.failureCode,
            chargeId: result.chargeId,
          });

    await this.outbox.append({ exchange: exchanges.events.name, message });
  }
}
