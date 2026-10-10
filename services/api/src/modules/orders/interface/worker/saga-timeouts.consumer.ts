import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { systemActor } from '@shared/auth/actor';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import { DELAYED_EXCHANGE } from '@shared/messaging/delayed';

import { ExpireSagaStepService } from '../../application/expire-saga-step.service';
import { ConsumerScope } from '../../infrastructure/consumer-scope';
import {
  SAGA_TIMEOUTS_QUEUE,
  SagaStepTimeoutV1,
} from '../../infrastructure/saga-step-timeout.message';

import { handleOnce } from './handle-once';

const ACTOR = systemActor('consumer:orders');

/**
 * The timeouts of the saga steps, when their wait is over: each was written with the step it
 * guards and spent the wait in a delay queue of the broker (docs/adr/0017-order-saga.md).
 * A timeout arrives whether its step was answered or not; a step that was is an
 * `InvalidStateError` of the saga, and the message is acknowledged.
 *
 * The message is the api's own, so it is validated with its own schema, not with
 * `parseMessage()`. The routing key is the queue: what is published there arrives at once.
 */
@Injectable()
export class SagaTimeoutsConsumer {
  constructor(
    private readonly scope: ConsumerScope,
    private readonly expireStep: ExpireSagaStepService,
  ) {}

  // the queue's arguments, its retry policy and its delay queues are added by RabbitSubscribers
  @RabbitSubscribe({
    exchange: DELAYED_EXCHANGE,
    routingKey: SAGA_TIMEOUTS_QUEUE,
    queue: SAGA_TIMEOUTS_QUEUE,
  })
  async onTimeout(raw: unknown): Promise<void> {
    const parsed = SagaStepTimeoutV1.schema.safeParse(raw);
    if (!parsed.success) {
      // not the message this queue is for: another delivery cannot help
      throw new UnprocessableMessageError(`invalid: ${z.prettifyError(parsed.error)}`);
    }
    const message = parsed.data;
    const { orderId, attempt, step } = message.payload;
    await handleOnce(this.scope, SAGA_TIMEOUTS_QUEUE, message, () =>
      this.expireStep.execute({ orderId, attempt, step }, ACTOR),
    );
  }
}
