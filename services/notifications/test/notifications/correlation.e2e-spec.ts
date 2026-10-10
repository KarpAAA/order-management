// The chain of an event, to the mail it ends in (LOG-041, LOG-043; docs/adr/0023). The mail
// is sent by a timer, after the message that asked for it was acknowledged: the notification
// keeps the correlation id of its event, and the dispatcher logs under it. The service logs
// to memory (helpers/log-capture.ts), so the test reads the lines as their collector would.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { newOrderId, newRecipient, orderPaid } from '../helpers/events';
import { waitForMails } from '../helpers/mailbox';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

import type { LogLine } from '../helpers/log-capture';

let app: WorkerApp;
let broker: TestBroker;

beforeAll(async () => {
  app = await createWorkerApp(); // first: it declares the queue the test publishes to
  broker = await connectTestBroker();
});
afterAll(async () => {
  try {
    await app.close();
  } finally {
    await broker.close();
  }
});

/** Until the service has written a line of the chain with this message. */
const logged = (correlationId: string, msg: string): Promise<LogLine[]> =>
  waitFor(
    () =>
      Promise.resolve(
        app.logs().filter((line) => line.correlationId === correlationId && line.msg === msg),
      ),
    (lines) => lines.length > 0,
    { what: `a "${msg}" line of ${correlationId}` },
  );

describe('the chain of an event reaches its mail', () => {
  it('LOG-041 keeps the correlation id of the event with the notification', async () => {
    const order = { orderId: newOrderId(), recipient: newRecipient() };
    const event = orderPaid(order);

    await broker.publish(event);
    await waitForMails(order.recipient.email);

    const row = await testDb().notification.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(row.correlationId).toBe(event.correlationId);
  });

  it('LOG-043 logs the delivery and the mail under the id of the event, without the address', async () => {
    const order = { orderId: newOrderId(), recipient: newRecipient() };
    const event = orderPaid(order);

    await broker.publish(event);
    await waitForMails(order.recipient.email);
    const [delivered] = await logged(event.correlationId, 'message delivered');
    const [sent] = await logged(event.correlationId, 'mail sent');

    expect(delivered).toMatchObject({
      level: 'info',
      service: 'notifications',
      queue: 'notifications.order-events',
      routingKey: 'orders.order-paid',
      outcome: 'ok',
    });
    expect(sent).toMatchObject({
      level: 'info',
      service: 'notifications',
      orderId: order.orderId,
      kind: 'order-paid',
      sendAttempts: 1,
    });
    expect(JSON.stringify(app.logs())).not.toContain(order.recipient.email);
  });

  it('LOG-043 says that a mail was given up at error, with the code of the server and no address', async () => {
    // the mail server of the run takes one domain only: any other is refused for good
    const order = { orderId: newOrderId(), recipient: newRecipient('elsewhere.test') };
    const event = orderPaid(order);

    await broker.publish(event);
    const [givenUp] = await logged(
      event.correlationId,
      'notification given up, its mail was not sent',
    );

    expect(givenUp).toMatchObject({
      level: 'error',
      orderId: order.orderId,
      kind: 'order-paid',
      retryable: false,
      smtpCode: 550,
    });
    expect(JSON.stringify(app.logs())).not.toContain(order.recipient.email);
  });
});
