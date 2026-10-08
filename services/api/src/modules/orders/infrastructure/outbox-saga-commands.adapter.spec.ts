// What the saga writes to the outbox besides the charge: the commands for inventory and its
// own timeouts (SAGA-001, 005, 016). The table and the relay are covered by the int suite.
import { parseMessage } from '@oms/contracts';
import { describe, expect, it } from 'vitest';

import type { OrderSagaConfig } from '@config/configuration';
import { correlationOf, recordingOutbox } from '@infra/outbox/__test__/recording-outbox';

import { fixedClock } from '../application/__test__/fixtures';
import { LATER, ORDER, PRODUCT_1, PRODUCT_2, WORKSPACE } from '../domain/__test__/builders';
import { OrderSagaStep, WAITING_STEPS } from '../domain/order-saga-step';

import { OutboxSagaTimeoutAdapter } from './outbox-saga-timeout.adapter';
import { OutboxStockReservationAdapter } from './outbox-stock-reservation.adapter';
import { SagaStepTimeoutV1 } from './saga-step-timeout.message';

const CORRELATION = '01990000-0000-7000-8000-c00000000001';
const PLACING = { workspaceId: WORKSPACE, orderId: ORDER, attempt: 2 };
const CONFIG: OrderSagaConfig = {
  reserveTimeoutMs: 60_000,
  chargeTimeoutMs: 150_000,
  compensationTimeoutMs: 45_000,
};

describe('OutboxStockReservationAdapter', () => {
  function adapter() {
    const { outbox, appended } = recordingOutbox();
    return {
      stock: new OutboxStockReservationAdapter(outbox, fixedClock, correlationOf(CORRELATION)),
      appended,
    };
  }

  it('SAGA-001 writes inventory.reserve-stock for the commands exchange, with the lines', async () => {
    const { stock, appended } = adapter();

    await stock.reserve({
      ...PLACING,
      lines: [
        { productId: PRODUCT_1, quantity: 2 },
        { productId: PRODUCT_2, quantity: 1 },
      ],
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]?.exchange).toBe('commands');
    expect(appended[0]?.message).toMatchObject({
      name: 'inventory.reserve-stock',
      version: 1,
      occurredAt: LATER.toISOString(),
      workspaceId: WORKSPACE,
      correlationId: CORRELATION,
      payload: {
        orderId: ORDER,
        attempt: 2,
        lines: [
          { productId: PRODUCT_1, quantity: 2 },
          { productId: PRODUCT_2, quantity: 1 },
        ],
      },
    });
    expect(parseMessage(appended[0]?.message)).toMatchObject({ ok: true });
  });

  it('carries nothing of a line but the product and the quantity', async () => {
    const { stock, appended } = adapter();
    const line = { productId: PRODUCT_1, quantity: 2, sku: 'SKU-1', unitPriceMinor: 1250n };

    await stock.reserve({ ...PLACING, lines: [line] });

    expect(appended[0]?.message).toMatchObject({
      payload: { lines: [{ productId: PRODUCT_1, quantity: 2 }] },
    });
    expect(JSON.stringify(appended[0]?.message)).not.toContain('SKU-1');
  });

  it('refuses a reservation of nothing instead of writing a command inventory would park', async () => {
    const { stock, appended } = adapter();

    await expect(stock.reserve({ ...PLACING, lines: [] })).rejects.toThrow();
    expect(appended).toEqual([]);
  });

  it('SAGA-005 writes inventory.release-stock for the attempt', async () => {
    const { stock, appended } = adapter();

    await stock.release(PLACING);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.exchange).toBe('commands');
    expect(appended[0]?.message).toMatchObject({
      name: 'inventory.release-stock',
      version: 1,
      workspaceId: WORKSPACE,
      correlationId: CORRELATION,
      payload: { orderId: ORDER, attempt: 2 },
    });
    expect(parseMessage(appended[0]?.message)).toMatchObject({ ok: true });
  });

  it('gives every command its own message id', async () => {
    const { stock, appended } = adapter();

    await stock.release(PLACING);
    await stock.release(PLACING);

    expect(appended[0]?.message.messageId).not.toBe(appended[1]?.message.messageId);
  });
});

describe('OutboxSagaTimeoutAdapter', () => {
  function adapter() {
    const { outbox, appended, delayed } = recordingOutbox();
    return {
      timeouts: new OutboxSagaTimeoutAdapter(
        outbox,
        fixedClock,
        correlationOf(CORRELATION),
        CONFIG,
      ),
      appended,
      delayed,
    };
  }

  it.each([
    { step: OrderSagaStep.Reserving, delayMs: 60_000 },
    { step: OrderSagaStep.Charging, delayMs: 150_000 },
    { step: OrderSagaStep.CancellingPayment, delayMs: 45_000 },
    { step: OrderSagaStep.Releasing, delayMs: 45_000 },
  ] as const)(
    'SAGA-016 writes the timeout of $step as a message delayed by $delayMs ms',
    async ({ step, delayMs }) => {
      const { timeouts, appended, delayed } = adapter();

      const deadline = await timeouts.schedule({ ...PLACING, step });

      expect(appended).toEqual([]);
      expect(delayed).toHaveLength(1);
      expect(delayed[0]).toMatchObject({ queue: 'api.saga-timeouts', delayMs });
      expect(delayed[0]?.message).toMatchObject({
        name: 'orders.saga-step-timeout',
        version: 1,
        occurredAt: LATER.toISOString(),
        workspaceId: WORKSPACE,
        correlationId: CORRELATION,
        payload: { orderId: ORDER, attempt: 2, step },
      });
      // the deadline of the step: when the message was written, plus its delay
      expect(deadline).toEqual(new Date(LATER.getTime() + delayMs));
    },
  );

  it('covers every step that waits', () => {
    expect(WAITING_STEPS).toHaveLength(4);
  });

  it('writes what its consumer accepts, and what parseMessage() does not know', async () => {
    const { timeouts, delayed } = adapter();

    await timeouts.schedule({ ...PLACING, step: OrderSagaStep.Charging });

    const message: unknown = JSON.parse(JSON.stringify(delayed[0]?.message));
    expect(SagaStepTimeoutV1.schema.safeParse(message).success).toBe(true);
    // not a contract between services: the registry of @oms/contracts has no entry for it
    expect(parseMessage(message)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('refuses a step that does not wait', () => {
    const forged = {
      ...SagaStepTimeoutV1.create(
        { messageId: ORDER, occurredAt: LATER, workspaceId: WORKSPACE, correlationId: CORRELATION },
        { orderId: ORDER, attempt: 1, step: OrderSagaStep.Charging },
      ),
    };

    expect(
      SagaStepTimeoutV1.schema.safeParse({
        ...forged,
        payload: { ...forged.payload, step: OrderSagaStep.Completed },
      }).success,
    ).toBe(false);
  });
});
