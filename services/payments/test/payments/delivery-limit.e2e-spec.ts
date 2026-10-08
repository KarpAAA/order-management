// A message that kills its consumer never reaches an error handler: the process is gone
// before anything can count the failure. The queue counts instead (`x-delivery-count` of a
// quorum queue), and the service parks a message the broker had to take back too many times
// before it hands it to the use case (PAY-019).
// A file of its own: the dying consumers below must be the only readers of the queue.
import { ChargePaymentV1 } from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TestPsp } from '../doubles/test-psp';
import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

const COMMANDS_QUEUE = 'payments.commands';
const DEAD_LETTER_QUEUE = 'payments.commands.dlq';
// .env.test: RABBITMQ_REDELIVERY_LIMIT
const REDELIVERY_LIMIT = 3;

const psp = new TestPsp();
let broker: TestBroker;
let service: WorkerApp | undefined;

beforeAll(async () => {
  broker = await connectTestBroker();
  // the service declares its queues, then leaves: nobody reads them
  await (await createWorkerApp(psp)).close();
});
afterAll(async () => {
  try {
    await service?.close();
  } finally {
    await broker.close();
  }
});

describe('a command whose consumer dies on every delivery (PAY-019)', () => {
  it('is parked at the redelivery limit without being charged', async () => {
    const orderId = uuidv7();
    const command = ChargePaymentV1.create(
      {
        messageId: uuidv7(),
        occurredAt: new Date(),
        workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
        correlationId: uuidv7(),
      },
      {
        orderId,
        paymentAttempt: 1,
        amount: { amountMinor: 12_50, currency: 'EUR' },
        idempotencyKey: `${orderId}:1`,
      },
    );
    await broker.send(command);

    // consumer after consumer takes the command and dies with it
    const counted: unknown[] = [];
    for (let death = 0; death < REDELIVERY_LIMIT; death += 1) {
      const headers = await waitFor(
        () => broker.crashOn(COMMANDS_QUEUE),
        (delivered) => delivered !== undefined,
        { what: 'a delivery of the command' },
      );
      counted.push(headers?.['x-delivery-count']);
    }
    // the broker counts each return of the message
    expect(counted).toEqual([undefined, 1, 2]);

    // a healthy consumer starts and gets the command, taken back three times already
    service = await createWorkerApp(psp);
    const [parked] = await waitFor(
      () => broker.take(DEAD_LETTER_QUEUE),
      (taken) => taken.length > 0,
      { what: 'the command in the dead-letter queue' },
    );

    expect(parked?.headers).toMatchObject({
      'x-parked-from': COMMANDS_QUEUE,
      'x-last-error': expect.stringContaining('redelivery limit'),
    });
    expect(JSON.parse(parked?.content.toString() ?? '')).toMatchObject({
      messageId: command.messageId,
    });
    // it was never handled: whatever killed the consumers did not get another chance
    expect(psp.calls(orderId)).toEqual([]);
    expect(await testDb().payment.count({ where: { orderId } })).toBe(0);
  });
});
