import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { exchanges, PaymentFailedV1, PaymentSucceededV1 } from '@oms/contracts';

import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';

import type {
  PaymentEventsPublisher,
  PaymentOutcome,
} from '../ports/payment-events-publisher.port';
import type { MessageMeta } from '@oms/contracts';

/**
 * Publishes the outcome as `payments.payment-succeeded` or `payments.payment-failed` to the
 * `events` exchange. The routing key is the name of the message; who reads it is not known
 * here: every subscriber binds its own queue.
 */
@Injectable()
export class RabbitPaymentEventsPublisher implements PaymentEventsPublisher {
  constructor(
    private readonly amqp: AmqpConnection,
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

    await this.amqp.publish(exchanges.events.name, message.name, message, {
      messageId: message.messageId,
      correlationId: message.correlationId,
    });
  }
}
