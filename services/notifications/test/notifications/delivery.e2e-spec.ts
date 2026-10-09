// What becomes of a notification when the mail server is away, refuses, or is shared by two
// dispatchers (NTF-010…016). The service of this file sends through a port of the test's own
// (helpers/smtp-gate.ts) in front of the run's Mailpit, so the server can go away and come
// back while the service keeps running. A file of its own: it changes how often a mail is
// tried, before the service boots.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectTestBroker, type TestBroker } from '../helpers/broker';
import { newOrderId, newRecipient, orderFulfilled, orderPaid } from '../helpers/events';
import { mailsTo, waitForMails } from '../helpers/mailbox';
import { startSmtpGate, type SmtpGate } from '../helpers/smtp-gate';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

// three tries: at once, half a second later, a second after that
const RETRY_DELAY_MS = 500;
const MAX_SEND_ATTEMPTS = 3;

let gate: SmtpGate;
let app: WorkerApp;
let secondApp: WorkerApp | undefined;
let broker: TestBroker;

beforeAll(async () => {
  gate = await startSmtpGate();
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(gate.port);
  process.env.NOTIFICATIONS_SEND_RETRY_DELAY_MS = String(RETRY_DELAY_MS);
  process.env.NOTIFICATIONS_MAX_SEND_ATTEMPTS = String(MAX_SEND_ATTEMPTS);
  app = await createWorkerApp(); // first: it declares the queue the test publishes to
  broker = await connectTestBroker();
});
afterAll(async () => {
  try {
    await secondApp?.close();
    await app.close();
  } finally {
    await broker.close();
    await gate.stop();
  }
});

const about = () => ({ orderId: newOrderId(), recipient: newRecipient() });

const notificationOf = (orderId: string) => testDb().notification.findFirst({ where: { orderId } });

type Row = Awaited<ReturnType<typeof notificationOf>>;

const waitForNotification = (
  orderId: string,
  done: (row: NonNullable<Row>) => boolean,
  what: string,
) =>
  waitFor(
    () => notificationOf(orderId),
    (row) => row !== null && done(row),
    { what: `the notification of order ${orderId} to be ${what}` },
  );

describe('the mail server is away (NTF-011, NTF-012)', () => {
  it('NTF-011 the notification waits, with the reason, and is sent when the server is back', async () => {
    const order = about();
    gate.close();

    await broker.publish(orderPaid(order));
    const waiting = await waitForNotification(
      order.orderId,
      (row) => row.sendAttempts >= 1,
      'tried once',
    );

    expect(waiting).toMatchObject({ status: 'PENDING', settledAt: null });
    expect(waiting?.lastError).toEqual(expect.any(String));
    expect(waiting?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() - RETRY_DELAY_MS);
    expect(await mailsTo(order.recipient.email)).toEqual([]);

    gate.open();
    const mails = await waitForMails(order.recipient.email);
    const sent = await waitForNotification(order.orderId, (row) => row.status === 'SENT', 'sent');

    expect(mails).toHaveLength(1);
    expect(sent?.sendAttempts).toBeGreaterThanOrEqual(2);
    expect(sent?.sendAttempts).toBeLessThanOrEqual(MAX_SEND_ATTEMPTS);
    // NTF-016: the try that worked went under the id every try had
    expect(mails[0]?.messageId).toBe(`${sent?.id ?? ''}@notifications.oms`);
  });

  it('NTF-012 after the last try it is given up, and is not sent when the server comes back', async () => {
    const order = about();
    gate.close();

    await broker.publish(orderPaid(order));
    const failed = await waitForNotification(
      order.orderId,
      (row) => row.status === 'FAILED',
      'given up',
    );

    expect(failed).toMatchObject({ sendAttempts: MAX_SEND_ATTEMPTS, nextAttemptAt: null });
    expect(failed?.settledAt).toBeInstanceOf(Date);

    gate.open();
    // a notification asked for now goes out: the dispatcher has passed over the failed one
    const next = about();
    await broker.publish(orderFulfilled(next));
    await waitForMails(next.recipient.email);

    expect(await mailsTo(order.recipient.email)).toEqual([]);
    expect(await notificationOf(order.orderId)).toMatchObject({ status: 'FAILED' });
  });

  it('NTF-014 a notification that waits for its next try does not hold the ones behind it', async () => {
    const stuck = about();
    const behind = about();
    gate.close();
    await broker.publish(orderPaid(stuck));
    await waitForNotification(stuck.orderId, (row) => row.sendAttempts >= 1, 'tried once');

    gate.open();
    await broker.publish(orderPaid(behind));
    const mails = await waitForMails(behind.recipient.email);

    expect(mails).toHaveLength(1);
    // and the first one follows on its own try
    expect(await waitForMails(stuck.recipient.email)).toHaveLength(1);
  });
});

describe('the mail server refuses a mail (NTF-013)', () => {
  it('gives it up on the first try, and goes on with the others', async () => {
    // the mail server of the run takes mail for one domain only (test/setup/mailpit.ts)
    const refused = { orderId: newOrderId(), recipient: newRecipient('refused.test') };
    const accepted = about();

    await broker.publish(orderPaid(refused));
    await broker.publish(orderPaid(accepted));
    const failed = await waitForNotification(
      refused.orderId,
      (row) => row.status === 'FAILED',
      'given up',
    );

    expect(failed).toMatchObject({ sendAttempts: 1, nextAttemptAt: null });
    expect(failed?.lastError).toEqual(expect.any(String));
    expect(await waitForMails(accepted.recipient.email)).toHaveLength(1);
    expect(await mailsTo(refused.recipient.email)).toEqual([]);
  });
});

describe('two processes of the service (NTF-015)', () => {
  const ORDERS = 30;

  it('share the events and the notifications, and send every mail once', async () => {
    secondApp = await createWorkerApp();
    const recipient = newRecipient();
    const orderIds = Array.from({ length: ORDERS }, newOrderId);

    await Promise.all(orderIds.map((orderId) => broker.publish(orderPaid({ orderId, recipient }))));
    const rows = await waitFor(
      () => testDb().notification.findMany({ where: { orderId: { in: orderIds } } }),
      (found) => found.length === ORDERS && found.every((row) => row.status === 'SENT'),
      { what: `${String(ORDERS)} notifications sent`, timeoutMs: 20_000 },
    );
    const mails = await mailsTo(recipient.email);

    // nothing is due any more, so nothing more will be sent: this count is final
    expect(mails).toHaveLength(ORDERS);
    expect(mails.map((mail) => mail.messageId).sort()).toEqual(
      rows.map((row) => `${row.id}@notifications.oms`).sort(),
    );
    expect(rows.every((row) => row.sendAttempts === 1)).toBe(true);
  });
});
