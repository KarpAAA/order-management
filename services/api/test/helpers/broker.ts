// The other side of the broker in a test: what inventory-service and payments-service are to
// the api. It reads the commands the api sends to the `commands` exchange through a queue of
// its own, and publishes the events those services would answer with to the `events`
// exchange. It also subscribes to the events the api publishes about its orders (`orders.*`).
// Neither service is in this suite: the full path is devtools/system (docs/adr/0022).
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import {
  CancelPaymentV1,
  ChargePaymentV1,
  exchanges,
  parseMessage,
  PaymentCancelledV1,
  PaymentFailedV1,
  PaymentSucceededV1,
  ReleaseStockV1,
  ReserveStockV1,
  StockReleasedV1,
  StockReservationFailedV1,
  StockReservedV1,
} from '@oms/contracts';
import { v7 as uuidv7 } from 'uuid';

import { waitFor } from './waiting';

import type { AnyMessage } from '@oms/contracts';

export interface Attempt {
  workspaceId: string;
  orderId: string;
  paymentAttempt: number;
}

/** A command the api sends, by the type of its contract. */
type CommandName =
  | typeof ReserveStockV1.name
  | typeof ReleaseStockV1.name
  | typeof ChargePaymentV1.name
  | typeof CancelPaymentV1.name;
type Command<N extends CommandName> = Extract<AnyMessage, { name: N }>;

export interface TestBrokerOptions {
  /**
   * `reserves` (the default): every `inventory.reserve-stock` is answered at once with
   * `inventory.stock-reserved`, as an inventory with endless stock would, so a test about
   * the payment sees its charge command without playing inventory first.
   * `silent`: nothing is answered; the test publishes what inventory says, or nothing.
   */
  inventory?: 'reserves' | 'silent';
}

export interface TestBroker {
  /** Charge commands the api sent for the order so far, in arrival order. */
  commands(orderId: string): ChargePaymentV1[];
  /** Until the api has sent `count` charge commands for the order. */
  waitForCommands(orderId: string, count?: number): Promise<ChargePaymentV1[]>;
  /** Commands of one kind the api sent for the order so far, in arrival order. */
  sent<N extends CommandName>(name: N, orderId: string): Command<N>[];
  /** Until the api has sent `count` commands of that kind for the order. */
  waitForSent<N extends CommandName>(
    name: N,
    orderId: string,
    count?: number,
  ): Promise<Command<N>[]>;
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
/** The commands of the saga: `commands` is a direct exchange, bound name by name. */
const COMMANDS: readonly CommandName[] = [
  ReserveStockV1.name,
  ReleaseStockV1.name,
  ChargePaymentV1.name,
  CancelPaymentV1.name,
];

const silent = { log: () => undefined, error: () => undefined, warn: () => undefined };

const meta = (workspaceId: string) => ({
  messageId: uuidv7(),
  occurredAt: new Date(),
  workspaceId,
  correlationId: uuidv7(),
});

const reservation = (attempt: Attempt) => ({
  orderId: attempt.orderId,
  attempt: attempt.paymentAttempt,
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

/** What payments-service answers when the attempt was cancelled before it was charged. */
export const paymentCancelled = (attempt: Attempt): PaymentCancelledV1 =>
  PaymentCancelledV1.create(meta(attempt.workspaceId), {
    orderId: attempt.orderId,
    paymentAttempt: attempt.paymentAttempt,
  });

/** What inventory-service answers when it holds the stock of the attempt. */
export const stockReserved = (attempt: Attempt): StockReservedV1 =>
  StockReservedV1.create(meta(attempt.workspaceId), reservation(attempt));

/** What inventory-service answers when a product of the attempt fell short. */
export const stockReservationFailed = (
  attempt: Attempt,
  shortages: { productId: string; requested: number; available: number }[],
): StockReservationFailedV1 =>
  StockReservationFailedV1.create(meta(attempt.workspaceId), {
    ...reservation(attempt),
    reason: 'insufficient_stock',
    shortages,
  });

/** What inventory-service answers when the attempt holds no stock (any more). */
export const stockReleased = (attempt: Attempt): StockReleasedV1 =>
  StockReleasedV1.create(meta(attempt.workspaceId), reservation(attempt));

export async function connectTestBroker({
  inventory = 'reserves',
}: TestBrokerOptions = {}): Promise<TestBroker> {
  const connection = new AmqpConnection({
    uri: process.env.RABBITMQ_URL ?? '',
    exchanges: Object.values(exchanges).map(({ name, type }) => ({ name, type })),
    enableDirectReplyTo: false,
    logger: silent,
  });
  await connection.init();

  const received: AnyMessage[] = [];
  const { channel } = connection;
  const { queue } = await channel.assertQueue('', { exclusive: true });
  for (const name of COMMANDS) await channel.bindQueue(queue, exchanges.commands.name, name);
  await channel.consume(
    queue,
    (raw) => {
      if (!raw) return;
      const parsed = parseMessage(JSON.parse(raw.content.toString()));
      // anything else would be a command the api must not send: let the test see it missing
      if (!parsed.ok) return;
      const { message } = parsed;
      received.push(message);
      if (inventory === 'reserves' && message.name === ReserveStockV1.name) {
        const answer = StockReservedV1.create(
          // the answer of a service carries the correlation id of its command
          { ...meta(message.workspaceId), correlationId: message.correlationId },
          { orderId: message.payload.orderId, attempt: message.payload.attempt },
        );
        void connection.publish(exchanges.events.name, answer.name, answer);
      }
    },
    { noAck: true },
  );

  const sent = <N extends CommandName>(name: N, orderId: string): Command<N>[] =>
    received.filter(
      (command): command is Command<N> =>
        command.name === name &&
        'orderId' in command.payload &&
        command.payload.orderId === orderId,
    );
  const waitForSent = <N extends CommandName>(name: N, orderId: string, count = 1) =>
    waitFor(
      () => Promise.resolve(sent(name, orderId)),
      (list) => list.length >= count,
      { what: `${String(count)} ${name} command(s) for order ${orderId}` },
    );

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
    commands: (orderId) => sent(ChargePaymentV1.name, orderId),
    waitForCommands: (orderId, count = 1) => waitForSent(ChargePaymentV1.name, orderId, count),
    sent,
    waitForSent,
    orderEvents,
    waitForOrderEvents: (orderId, count = 1) =>
      waitFor(
        () => Promise.resolve(orderEvents(orderId)),
        (list) => list.length >= count,
        { what: `${String(count)} event(s) of order ${orderId}` },
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
