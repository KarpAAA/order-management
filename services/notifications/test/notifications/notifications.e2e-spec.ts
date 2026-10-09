// notifications-service to its boundary (NTF-001…005, 020, 021, 023): an event of an order
// goes in through RabbitMQ, a row and a mail come out. Neither the api nor a real mailbox is
// here: the test is the publisher (helpers/broker.ts, helpers/events.ts) and reads what the
// mail server of the run took (helpers/mailbox.ts). What happens when that server is away is
// in delivery.e2e-spec.ts.
// The service takes one event at a time (`RABBITMQ_PREFETCH=1`), which is what makes
// `handledUpTo()` a proof: an event published later is handled later.
import { PaymentSucceededV1 } from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// relative: a job is not part of the module's index, and test/ reaches it only here
import { CleanupNotificationsJob } from '../../src/modules/notifications/interface/worker/cleanup-notifications.job';
import { connectTestBroker, type TestBroker } from '../helpers/broker';
import {
  EVERY_EVENT,
  newOrderId,
  newRecipient,
  OCCURRED_AT,
  orderCancelled,
  orderFulfilled,
  orderPaid,
  orderPaymentFailed,
  orderPlaced,
  WORKSPACE,
} from '../helpers/events';
import { mailsTo, waitForMails } from '../helpers/mailbox';
import { waitFor } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { testDb } from '../setup/db';

// the queues the service declares for itself: names on the wire, so the test spells them out
const QUEUE = 'notifications.order-events';
const DEAD_LETTER_QUEUE = 'notifications.order-events.dlq';
const OTHER_WORKSPACE = '01950000-0000-7000-8000-00000000a002';

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

const about = () => ({ orderId: newOrderId(), recipient: newRecipient() });

const notificationsOf = (orderId: string) =>
  testDb().notification.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });

/** Until every notification of the order was sent or given up; `count` of them at least. */
const settledOf = (orderId: string, count = 1) =>
  waitFor(
    () => notificationsOf(orderId),
    (rows) => rows.length >= count && rows.every((row) => row.status !== 'PENDING'),
    { what: `${String(count)} settled notification(s) of order ${orderId}` },
  );

/** Everything published before this call was handled: an event sent now is handled after it. */
async function handledUpTo(): Promise<void> {
  const marker = about();
  await broker.publish(orderFulfilled(marker));
  await settledOf(marker.orderId);
}

describe('an event of an order becomes one mail to its recipient (NTF-001, NTF-002)', () => {
  it.each(EVERY_EVENT)('$kind → "$subject"', async ({ kind, subject, build }) => {
    const order = about();

    await broker.publish(build(order));
    const mails = await waitForMails(order.recipient.email);
    const rows = await settledOf(order.orderId);

    expect(rows).toEqual([
      expect.objectContaining({
        kind,
        workspaceId: WORKSPACE,
        recipientUserId: order.recipient.userId,
        recipientEmail: order.recipient.email,
        status: 'SENT',
        sendAttempts: 1,
        nextAttemptAt: null,
        lastError: null,
        occurredAt: OCCURRED_AT,
      }),
    ]);
    expect(mails).toEqual([
      expect.objectContaining({
        to: [order.recipient.email],
        from: 'orders@oms.test',
        subject,
        // NTF-016: the id of the notification, the same for every try of it
        messageId: `${rows[0]?.id ?? ''}@notifications.oms`,
      }),
    ]);
    // what was sent is what was written when the event arrived (a mail ends its lines with CRLF)
    expect(mails[0]?.text.replaceAll('\r\n', '\n').trim()).toBe(rows[0]?.body.trim());
  });

  it('NTF-002 the mail names the order and says when the fact happened, not when it was sent', async () => {
    const order = about();

    await broker.publish(orderPaid(order));
    const [mail] = await waitForMails(order.recipient.email);

    expect(mail?.text).toContain(`Order ${order.orderId}`);
    expect(mail?.text).toContain('2026-03-04 05:06 UTC');
    expect(mail?.text).toContain('129.90 EUR');
  });

  it('NTF-020 the workspace of a notification is the one of the envelope', async () => {
    const order = { ...about(), workspaceId: OTHER_WORKSPACE };

    await broker.publish(orderCancelled(order));

    expect(await settledOf(order.orderId)).toMatchObject([{ workspaceId: OTHER_WORKSPACE }]);
  });
});

describe('the user is told a fact once (NTF-003, NTF-004)', () => {
  it('NTF-003 the same message delivered twice is one notification and one mail', async () => {
    const order = about();
    const message = orderPaid(order);

    await broker.publish(message);
    await broker.publish(message);
    await handledUpTo();

    expect(await notificationsOf(order.orderId)).toHaveLength(1);
    expect(await mailsTo(order.recipient.email)).toHaveLength(1);
    // the inbox is what knew: one record for the message
    expect(await testDb().inboxMessage.count({ where: { messageId: message.messageId } })).toBe(1);
  });

  it('NTF-004 another message about the same fact is handled, and tells nothing new', async () => {
    const order = about();
    const first = orderPaid(order);
    const second = orderPaid(order);

    await broker.publish(first);
    await broker.publish(second);
    await handledUpTo();

    expect(await notificationsOf(order.orderId)).toHaveLength(1);
    expect(await mailsTo(order.recipient.email)).toHaveLength(1);
    // both were recorded: the second is not a duplicate for the inbox, it is one for the fact
    expect(
      await testDb().inboxMessage.count({
        where: { messageId: { in: [first.messageId, second.messageId] } },
      }),
    ).toBe(2);
    expect(await broker.depth(DEAD_LETTER_QUEUE)).toBe(0);
  });

  it('NTF-004 the next attempt of the order is another fact: a second mail', async () => {
    const order = about();

    await broker.publish(orderPaymentFailed(order));
    await broker.publish(orderPaymentFailed({ ...order, paymentAttempt: 2 }));
    const mails = await waitForMails(order.recipient.email, 2);

    expect(mails).toHaveLength(2);
    expect((await settledOf(order.orderId, 2)).map((row) => row.attempt)).toEqual([1, 2]);
  });
});

describe('no mail waits for another event (NTF-005)', () => {
  it('"paid" and "fulfilled" before "placed": three mails, each from its own event', async () => {
    const order = about();

    // a redelivery returned "placed" behind the events published meanwhile
    await broker.publish(orderPaid(order));
    await broker.publish(orderFulfilled(order));
    await broker.publish(orderPlaced(order));
    const mails = await waitForMails(order.recipient.email, 3);

    expect(mails.map((mail) => mail.subject).sort()).toEqual([
      'We received your order',
      'Your order is paid',
      'Your order was fulfilled',
    ]);
    expect((await settledOf(order.orderId, 3)).map((row) => row.kind)).toEqual([
      'order-paid',
      'order-fulfilled',
      'order-placed',
    ]);
  });

  it('"paid" after "cancelled": the payment was first, and the user hears both', async () => {
    const order = about();

    await broker.publish(orderCancelled(order));
    await broker.publish(orderPaid(order));
    const mails = await waitForMails(order.recipient.email, 2);

    expect(mails.map((mail) => mail.subject).sort()).toEqual([
      'Your order is paid',
      'Your order was cancelled',
    ]);
  });
});

describe('what is not an event of this queue is parked at once (NTF-021)', () => {
  const parked = async (): Promise<unknown[]> =>
    (await broker.take(DEAD_LETTER_QUEUE)).map(
      ({ content }) => JSON.parse(content.toString()) as unknown,
    );

  it('a version of a contract this build does not know', async () => {
    const unknown = { ...orderPaid(about()), version: 2 };

    broker.put(QUEUE, Buffer.from(JSON.stringify(unknown)));
    await handledUpTo();

    expect(await parked()).toEqual([unknown]);
    expect(await testDb().inboxMessage.count({ where: { messageId: unknown.messageId } })).toBe(0);
  });

  it('an event that names no recipient', async () => {
    const order = about();
    const event = orderPaid(order);
    // JSON drops a key that is undefined: the message arrives without it
    const nameless = { ...event, payload: { ...event.payload, recipient: undefined } };

    broker.put(QUEUE, Buffer.from(JSON.stringify(nameless)));
    await handledUpTo();

    expect(await parked()).toEqual([nameless]);
    expect(await notificationsOf(order.orderId)).toEqual([]);
  });

  it('a contract of another service that somebody moved into the queue', async () => {
    const orderId = newOrderId();
    const foreign = PaymentSucceededV1.create(
      {
        messageId: uuidv7(),
        occurredAt: OCCURRED_AT,
        workspaceId: WORKSPACE,
        correlationId: uuidv7(),
      },
      { orderId, paymentAttempt: 1, chargeId: 'ch_1' },
    );

    broker.put(QUEUE, Buffer.from(JSON.stringify(foreign)));
    await handledUpTo();

    expect(await parked()).toEqual([foreign]);
    expect(await notificationsOf(orderId)).toEqual([]);
  });
});

describe('retention (NTF-023)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

  /** A row as the service would have left it, written as the owner. */
  const stored = (status: 'SENT' | 'FAILED' | 'PENDING', at: Date) => {
    const { recipient, orderId } = about();
    return {
      id: uuidv7(),
      workspaceId: WORKSPACE,
      orderId,
      kind: 'order-paid',
      attempt: 1,
      recipientUserId: recipient.userId,
      recipientEmail: recipient.email,
      subject: 'Your order is paid',
      body: 'kept for the retention test',
      status,
      sendAttempts: 1,
      // a PENDING row is due far ahead: the dispatcher of this file leaves it alone
      nextAttemptAt: status === 'PENDING' ? new Date(Date.now() + DAY_MS) : null,
      occurredAt: at,
      createdAt: at,
      settledAt: status === 'PENDING' ? null : at,
    };
  };

  it('deletes what was sent or given up before the retention, and nothing that still waits', async () => {
    // .env.test leaves NOTIFICATIONS_RETENTION_DAYS at its default: 30
    const rows = {
      oldSent: stored('SENT', daysAgo(31)),
      oldFailed: stored('FAILED', daysAgo(31)),
      recentSent: stored('SENT', daysAgo(29)),
      oldPending: stored('PENDING', daysAgo(60)),
    };
    await testDb().notification.createMany({ data: Object.values(rows) });

    await app.get(CleanupNotificationsJob).run();

    const left = await testDb().notification.findMany({
      where: { id: { in: Object.values(rows).map((row) => row.id) } },
      select: { id: true },
    });
    expect(left.map((row) => row.id).sort()).toEqual(
      [rows.recentSent.id, rows.oldPending.id].sort(),
    );
  });
});
