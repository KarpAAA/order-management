import { defineMessage } from '@oms/contracts';
import { z } from 'zod';

import { WAITING_STEPS } from '../domain/order-saga-step';

/** The queue of the worker that reads the timeouts when their wait is over. */
export const SAGA_TIMEOUTS_QUEUE = 'api.saga-timeouts';

/**
 * "This step of the saga has waited long enough." A message the api sends to itself, through
 * the outbox and a delay queue of the broker (infrastructure/messaging/delay-topology.ts).
 *
 * Built like a contract, with the same envelope, but not one of `@oms/contracts`: no other
 * service sends or reads it, so it is not in the registry and `parseMessage()` does not know
 * it. Its consumer validates it with this schema.
 */
export const SagaStepTimeoutV1 = defineMessage(
  'orders.saga-step-timeout',
  1,
  z.object({
    orderId: z.uuid(),
    attempt: z.int().positive(),
    /** The step that began when the message was written. */
    step: z.enum(WAITING_STEPS),
  }),
);

export type SagaStepTimeoutV1 = z.infer<typeof SagaStepTimeoutV1.schema>;
