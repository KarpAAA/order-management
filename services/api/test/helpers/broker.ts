// The other side of the broker in a test: what payments-service is to the api. It reads the
// commands the api sends to the `commands` exchange through a queue of its own, and publishes
// the events payments-service would answer with to the `events` exchange. It also subscribes
// to the events the api publishes about its orders (`orders.*`).
// payments-service itself is not in this suite: the full path is ROADMAP 3.13.
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import {
  ChargePaymentV1,
  exchanges,
  parseMessage,
  PaymentFailedV1,
  PaymentSucceededV1,
} from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';

import { waitFor } from './waiting';

import type { AnyMessage } from '@oms/contracts';

export interface Attempt {
  workspaceId: string;
  orderId: string;
  paymentAttempt: number;
}

export interface TestBroker {
  /** Charge commands the api sent for the order so far, in arrival order. */
  commands(orderId: string): ChargePaymentV1[];
  /** Until the api has sent `count` charge commands for the order. */
  waitForCommands(orderId: string, count?: number): Promise<ChargePaymentV1[]>;
  /** The `orders.*` events the api published about the order so far, in arrival order. */
  orderEvents(orderId: string): AnyMessage[];
  /** Until the api has published `count` events about the order. */
  waitForOrderEvents(orderId: string, count?: number): Promise<AnyMessage[]>;
  /** Publishes to `events` with the message's name as the routing key. */
  publish(message: { name: string }): Promise<void>;
  /** Publishes bytes as they are: for what no producer of ours would send. */
  publishRaw(routingKey: string, content: Buffer): void;
  /** Messages in a queue that no consumer has taken yet. */
  depth(queue: string): Promise<number>;
  /** Takes every message out of a queue nobody consumes (a dead-letter queue). */
  take(queue: string): Promise<TakenMessage[]>;
  /** Puts a message straight into a queue, as an operator moving it back would. */
  put(queue: string, content: Buffer, headers?: Record<string, unknown>): void;
  close(): Promise<void>;
}

export interface TakenMessage {
  content: Buffer;
  headers: Record<string, unknown>;
}

/** Every event of orders: `events` is a topic exchange, and the routing key is the name. */
const ORDER_EVENTS = 'orders.*';

const silent = { log: () => undefined, error: () => undefined, warn: () => undefined };

const meta = (workspaceId: string) => ({
  messageId: uuidv7(),
  occurredAt: new Date(),
  workspaceId,
  correlationId: uuidv7(),
});

/** What payments-service answers when the provider charged the attempt. */
export const paymentSucceeded = (attempt: Attempt, chargeId: string): PaymentSucceededV1 =>
  PaymentSucceededV1.create(meta(attempt.workspaceId), {
    orderId: attempt.orderId,
    paymentAttempt: attempt.paymentAttempt,
    chargeId,
  });

/** What payments-service answers when the attempt ended without a charge. */
export const paymentFailed = (attempt: Attempt, declineCode: string): PaymentFailedV1 =>
  PaymentFailedV1.create(meta(attempt.workspaceId), {
    orderId: attempt.orderId,
    paymentAttempt: attempt.paymentAttempt,
    declineCode,
    chargeId: null,
  });

export async function connectTestBroker(): Promise<TestBroker> {
  const connection = new AmqpConnection({
    uri: process.env.RABBITMQ_URL ?? '',
    exchanges: Object.values(exchanges).map(({ name, type }) => ({ name, type })),
    enableDirectReplyTo: false,
    logger: silent,
  });
  await connection.init();

  const received: ChargePaymentV1[] = [];
  const { channel } = connection;
  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, exchanges.commands.name, ChargePaymentV1.name);
  await channel.consume(
    queue,
    (raw) => {
      if (!raw) return;
      const parsed = parseMessage(JSON.parse(raw.content.toString()));
      // anything else would be a command the api must not send: let the test see it missing
      if (parsed.ok && parsed.message.name === ChargePaymentV1.name) received.push(parsed.message);
    },
    { noAck: true },
  );

  const commands = (orderId: string): ChargePaymentV1[] =>
    received.filter((command) => command.payload.orderId === orderId);

  // a subscriber of the api's own events, as inventory or notifications will be
  const published: AnyMessage[] = [];
  const subscription = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(subscription.queue, exchanges.events.name, ORDER_EVENTS);
  await channel.consume(
    subscription.queue,
    (raw) => {
      if (!raw) return;
      const parsed = parseMessage(JSON.parse(raw.content.toString()));
      if (parsed.ok) published.push(parsed.message);
    },
    { noAck: true },
  );

  const orderEvents = (orderId: string): AnyMessage[] =>
    // not every message is about an order (`inventory.stock-adjusted` is about a product)
    published.filter(({ payload }) => 'orderId' in payload && payload.orderId === orderId);

  return {
    commands,
    orderEvents,
    waitForOrderEvents: (orderId, count = 1) =>
      waitFor(
        () => Promise.resolve(orderEvents(orderId)),
        (list) => list.length >= count,
        { what: `${String(count)} event(s) of order ${orderId}` },
      ),
    waitForCommands: (orderId, count = 1) =>
      waitFor(
        () => Promise.resolve(commands(orderId)),
        (list) => list.length >= count,
        { what: `${String(count)} charge command(s) for order ${orderId}` },
      ),
    publish: async (message) => {
      await connection.publish(exchanges.events.name, message.name, message);
    },
    publishRaw: (routingKey, content) => {
      channel.publish(exchanges.events.name, routingKey, content);
    },
    depth: async (name) => (await channel.checkQueue(name)).messageCount,
    take: async (name) => {
      const taken: TakenMessage[] = [];
      for (;;) {
        const raw = await channel.get(name, { noAck: true });
        if (!raw) return taken;
        taken.push({ content: raw.content, headers: raw.properties.headers ?? {} });
      }
    },
    put: (name, content, headers = {}) => {
      channel.sendToQueue(name, content, { persistent: true, headers });
    },
    close: () => connection.close(),
  };
}
