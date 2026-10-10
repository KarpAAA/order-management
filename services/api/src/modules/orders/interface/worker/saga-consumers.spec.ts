// The two consumers the saga added: the answers of inventory and the timeouts of its steps.
// What a consumer does around its use case (tenant, correlation, inbox, what an error means)
// is `handleOnce()`, shared with PaymentEventsConsumer and pinned in its spec; here: which
// message calls which use case with what, and what is not a message of the queue.
import {
  StockAdjustedV1,
  StockReleasedV1,
  StockReservationFailedV1,
  StockReservedV1,
} from '@oms/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CorrelationContext } from '@common/messaging/correlation-context';
import type { TenantContext } from '@common/tenancy/tenant-context';
import { InvalidStateError, NotFoundError } from '@shared/errors/domain-error';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import { silentLogger } from '@shared/logger/silent-logger';
import type { Inbox } from '@shared/messaging/inbox';

import { OrderSagaStep } from '../../domain/order-saga-step';
import { SagaStepTimeoutV1 } from '../../infrastructure/saga-step-timeout.message';

import { InventoryEventsConsumer } from './inventory-events.consumer';
import { SagaTimeoutsConsumer } from './saga-timeouts.consumer';

import type { ConfirmStockReleaseService } from '../../application/confirm-stock-release.service';
import type { ConfirmStockReservationService } from '../../application/confirm-stock-reservation.service';
import type { ExpireSagaStepService } from '../../application/expire-saga-step.service';
import type { RejectStockReservationService } from '../../application/reject-stock-reservation.service';
import type { MessageMeta } from '@oms/contracts';

const WORKSPACE = '01990000-0000-7000-8000-a00000000000';
const ORDER = '01990000-0000-7000-8000-a20000000001';
const PRODUCT = '01990000-0000-7000-8000-a10000000001';

const META: MessageMeta = {
  messageId: '01990000-0000-7000-8000-a30000000001',
  occurredAt: new Date('2026-10-06T10:15:30.123Z'),
  workspaceId: WORKSPACE,
  correlationId: '01990000-0000-7000-8000-a30000000002',
};
const ATTEMPT = { orderId: ORDER, attempt: 2 };
const ACTOR = expect.objectContaining({ kind: 'system', source: 'consumer:orders' });

class NotWaiting extends InvalidStateError {
  readonly code = 'ORDER_SAGA_NOT_WAITING';
}

class SagaNotFound extends NotFoundError {
  readonly code = 'ORDER_SAGA_NOT_FOUND';
}

/** The inbox without a database: a message is recorded when its handler returns, as on commit. */
class MemoryInbox implements Inbox {
  readonly handled: string[] = [];

  async once(consumer: string, messageId: string, handle: () => Promise<void>): Promise<boolean> {
    const key = `${consumer}/${messageId}`;
    if (this.handled.includes(key)) return false;
    await handle();
    this.handled.push(key);
    return true;
  }
}

function scope() {
  const runInWorkspace = vi.fn((_workspaceId: string, work: () => Promise<unknown>) => work());
  const continued: string[] = [];
  const inbox = new MemoryInbox();
  return {
    tenant: { runInWorkspace } as unknown as TenantContext,
    correlation: { continue: (id: string) => continued.push(id) } as unknown as CorrelationContext,
    inbox,
    logger: silentLogger,
    runInWorkspace,
    continued,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InventoryEventsConsumer', () => {
  const reserved = StockReservedV1.create(META, ATTEMPT);
  const shortages = [{ productId: PRODUCT, requested: 3, available: 1 }];
  const refused = StockReservationFailedV1.create(META, {
    ...ATTEMPT,
    reason: 'insufficient_stock',
    shortages,
  });
  const released = StockReleasedV1.create(META, ATTEMPT);

  function consumerWith(outcome: () => Promise<void> = () => Promise.resolve()) {
    const confirm = vi.fn(outcome);
    const reject = vi.fn(outcome);
    const release = vi.fn(outcome);
    const s = scope();
    const consumer = new InventoryEventsConsumer(
      s,
      { execute: confirm } as unknown as ConfirmStockReservationService,
      { execute: reject } as unknown as RejectStockReservationService,
      { execute: release } as unknown as ConfirmStockReleaseService,
    );
    return { consumer, confirm, reject, release, ...s };
  }

  it('SAGA-002 confirms the reservation of the attempt, as the consumer system actor', async () => {
    const { consumer, confirm, reject, release } = consumerWith();

    await expect(consumer.onInventoryEvent(reserved)).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalledWith(ATTEMPT, ACTOR);
    expect(reject).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('SAGA-003 rejects the reservation with the shortages inventory reported', async () => {
    const { consumer, confirm, reject } = consumerWith();

    await consumer.onInventoryEvent(refused);

    expect(reject).toHaveBeenCalledWith({ ...ATTEMPT, shortages }, ACTOR);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('SAGA-006 confirms the release of the attempt', async () => {
    const { consumer, release, confirm } = consumerWith();

    await consumer.onInventoryEvent(released);

    expect(release).toHaveBeenCalledWith(ATTEMPT, ACTOR);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('PAY-012 OBX-008 binds the tenant and continues the correlation of the message', async () => {
    const { consumer, runInWorkspace, continued } = consumerWith();

    await consumer.onInventoryEvent(reserved);

    expect(runInWorkspace).toHaveBeenCalledWith(WORKSPACE, expect.any(Function));
    expect(continued).toEqual([META.correlationId]);
  });

  it('IBX-001 handles a message once, under the name of its own queue', async () => {
    const { consumer, confirm, inbox } = consumerWith();

    await consumer.onInventoryEvent(reserved);
    await consumer.onInventoryEvent(reserved);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(inbox.handled).toEqual([`api.inventory-events/${META.messageId}`]);
  });

  it('SAGA-011 acknowledges an answer the saga is not waiting for', async () => {
    const { consumer } = consumerWith(() => Promise.reject(new NotWaiting('not waiting')));

    await expect(consumer.onInventoryEvent(reserved)).resolves.toBeUndefined();
  });

  it('SAGA-012 lets a failure that may pass out: the message is delivered again', async () => {
    const error = new Error('database is down');
    const { consumer, inbox } = consumerWith(() => Promise.reject(error));

    await expect(consumer.onInventoryEvent(reserved)).rejects.toBe(error);
    expect(inbox.handled).toEqual([]);
  });

  it('SAGA-013 gives up an answer for an attempt that has no saga here', async () => {
    const refusal = new SagaNotFound('no saga');
    const { consumer } = consumerWith(() => Promise.reject(refusal));

    const thrown = await consumer.onInventoryEvent(reserved).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(UnprocessableMessageError);
    expect(thrown).toMatchObject({ message: 'ORDER_SAGA_NOT_FOUND: no saga', cause: refusal });
  });

  it.each([
    ['not a message', { hello: 'world' }],
    ['a version this build does not know', { ...reserved, version: 2 }],
    ['an event that breaks its contract', { ...reserved, payload: { orderId: 'nope' } }],
    [
      'an event of inventory no order waits for',
      StockAdjustedV1.create(META, { productId: PRODUCT, onHand: 5, reserved: 0 }),
    ],
  ])('PAY-015 gives up %s and calls no use case', async (_case, raw) => {
    const { consumer, confirm, reject, release } = consumerWith();

    await expect(consumer.onInventoryEvent(raw)).rejects.toThrow(UnprocessableMessageError);

    expect(confirm).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});

describe('SagaTimeoutsConsumer', () => {
  const timeout = SagaStepTimeoutV1.create(META, { ...ATTEMPT, step: OrderSagaStep.Charging });

  function consumerWith(execute = vi.fn().mockResolvedValue(undefined)) {
    const s = scope();
    const consumer = new SagaTimeoutsConsumer(s, {
      execute,
    } as unknown as ExpireSagaStepService);
    return { consumer, execute, ...s };
  }

  it('SAGA-008 expires the step the timeout was written for, as the consumer system actor', async () => {
    const { consumer, execute } = consumerWith();

    // as it comes off the wire
    await expect(consumer.onTimeout(JSON.parse(JSON.stringify(timeout)))).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledWith({ ...ATTEMPT, step: OrderSagaStep.Charging }, ACTOR);
  });

  it('PAY-012 OBX-008 binds the tenant and continues the correlation of the step', async () => {
    const { consumer, runInWorkspace, continued } = consumerWith();

    await consumer.onTimeout(timeout);

    expect(runInWorkspace).toHaveBeenCalledWith(WORKSPACE, expect.any(Function));
    expect(continued).toEqual([META.correlationId]);
  });

  it('IBX-001 handles a timeout once, under the name of its own queue', async () => {
    const { consumer, execute, inbox } = consumerWith();

    await consumer.onTimeout(timeout);
    await consumer.onTimeout(timeout);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(inbox.handled).toEqual([`api.saga-timeouts/${META.messageId}`]);
  });

  it('SAGA-010 acknowledges the timeout of a step that was answered in time', async () => {
    const { consumer } = consumerWith(vi.fn().mockRejectedValue(new NotWaiting('answered')));

    await expect(consumer.onTimeout(timeout)).resolves.toBeUndefined();
  });

  it('SAGA-013 gives up a timeout for an attempt that has no saga here', async () => {
    const { consumer } = consumerWith(vi.fn().mockRejectedValue(new SagaNotFound('no saga')));

    await expect(consumer.onTimeout(timeout)).rejects.toThrow(UnprocessableMessageError);
  });

  it.each([
    ['bytes that were not JSON', 'not json'],
    ['not a message', { hello: 'world' }],
    ['a version this build does not know', { ...timeout, version: 2 }],
    ['a step that does not wait', { ...timeout, payload: { ...ATTEMPT, step: 'COMPLETED' } }],
    ['a message of another queue', StockReservedV1.create(META, ATTEMPT)],
  ])('PAY-015 gives up %s and calls no use case', async (_case, raw) => {
    const { consumer, execute } = consumerWith();

    await expect(consumer.onTimeout(raw)).rejects.toThrow(UnprocessableMessageError);

    expect(execute).not.toHaveBeenCalled();
  });
});
