import type { RetryPolicy } from '@config/configuration';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import type { Logger } from '@shared/logger/logger';
import type { Delivery } from '@shared/messaging/delivery';

import { correlationOf } from './message-correlation';
import { deadLetterQueue, rejections } from './retry-topology';

import type { BrokerMeters } from './broker.meters';
import type { MessageErrorHandler } from '@golevelup/nestjs-rabbitmq';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

export function deliveryOf(
  message: ConsumeMessage | undefined,
  queue: string,
  policy: RetryPolicy,
): Delivery {
  const attempt = rejections(message, queue) + 1;
  return { attempt, last: attempt >= policy.maxAttempts };
}

/** The scope of a chain: `CorrelationContext`, as much of it as is needed here. */
export interface CorrelationScope {
  run<T>(correlationId: string, work: () => T): T;
}

export interface RetryContext {
  logger: Logger;
  correlation: CorrelationScope;
  /** Left out, nothing is counted. */
  meters?: BrokerMeters;
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Publishes to the dead-letter queue and resolves once the broker has the message. */
function park(channel: ConfirmChannel, queue: string, message: ConsumeMessage, error: unknown) {
  // `x-death` is the broker's own record; kept under another name, a message put back in its
  // queue by an operator starts with every delivery it is entitled to
  const { 'x-death': deaths, ...headers } = message.properties.headers ?? {};
  return new Promise<void>((resolve, reject) => {
    channel.sendToQueue(
      deadLetterQueue(queue),
      message.content,
      {
        persistent: true,
        headers: {
          ...headers,
          'x-parked-from': queue,
          'x-parked-deaths': deaths,
          'x-last-error': describe(error),
        },
      },
      (err: unknown) => {
        if (err) reject(err instanceof Error ? err : new Error(describe(err)));
        else resolve();
      },
    );
  });
}

/**
 * What happens to a message whose handler threw.
 *  - a failure that may pass, deliveries left → rejected: the broker moves it to the wait
 *    queue and back after the delay;
 *  - `UnprocessableMessageError`, or the last delivery → the dead-letter queue, and an error
 *    in the log: somebody has to look at it.
 * Never put back at once: a message that fails every time would spin (docs/adr/0013).
 *
 * It runs after the handler, outside the scope the handler had: the correlation id of its
 * lines is read from the message again.
 */
export const retryOrPark =
  (
    queue: string,
    policy: RetryPolicy,
    { logger, correlation, meters }: RetryContext,
  ): MessageErrorHandler =>
  (channel, message, error: unknown) =>
    correlation.run(correlationOf(message), async () => {
      const messageId: unknown = message.properties.messageId;
      const fields = { queue, messageId };
      try {
        const { attempt, last } = deliveryOf(message, queue, policy);
        const delivery = { ...fields, attempt, maxAttempts: policy.maxAttempts };
        if (!(error instanceof UnprocessableMessageError) && !last) {
          logger.warn(
            { ...delivery, retryInMs: policy.delayMs, err: error },
            'delivery failed, the message comes again',
          );
          channel.nack(message, false, false);
          meters?.retried(queue);
          return;
        }
        // the consumer channels of the connection are confirm channels (amqp-connection-manager)
        await park(channel as ConfirmChannel, queue, message, error);
        channel.ack(message);
        meters?.parked(queue);
        logger.error(
          { ...delivery, deadLetterQueue: deadLetterQueue(queue), err: error },
          'message parked',
        );
      } catch (err: unknown) {
        logger.error({ ...fields, err }, 'a failed message could not be settled');
        try {
          // the broker refused the copy: through the wait queue, and parked on the way back
          channel.nack(message, false, false);
        } catch {
          // the channel is gone: the broker has taken the unacknowledged message back already
        }
      }
    });
