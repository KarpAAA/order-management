import { AmqpConnection, RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';
import { Inject, Injectable } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { CorrelationContext } from '@common/messaging/correlation-context';
import { rabbitConfig } from '@config/configuration';
import type { RabbitConfig, RetryPolicy } from '@config/configuration';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import { LOGGER, type Logger } from '@shared/logger/logger';
import type { Delivery } from '@shared/messaging/delivery';
import { METRICS, type Metrics } from '@shared/observability/metrics';

import { brokerMeters, type BrokerMeters } from './broker.meters';
import { declareDelayQueues } from './delay-topology';
import { correlationOf } from './message-correlation';
import { deliveryOf, retryOrPark } from './retry-or-park';
import { declareRetryQueues, redeliveries, workQueueOptions } from './retry-topology';

import type { RabbitHandlerConfig } from '@golevelup/nestjs-rabbitmq';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

/** A `@RabbitSubscribe` method: the body of the message, and which delivery of it this is. */
type Handler = (message: unknown, delivery: Delivery) => Promise<unknown>;
type Methods = Record<string, Handler | undefined>;

/** One `@RabbitSubscribe` method and the queue it reads. */
interface Subscription {
  instance: Methods;
  name: string;
  queue: string;
  policy: RetryPolicy;
}

const subscription = (method: unknown): RabbitHandlerConfig | undefined => {
  if (typeof method !== 'function') return undefined;
  const config = Reflect.getMetadata(RABBIT_HANDLER, method) as RabbitHandlerConfig | undefined;
  return config?.type === 'subscribe' ? config : undefined;
};

/**
 * Starts every `@RabbitSubscribe` method of the providers of THIS application, and closes the
 * connection with it.
 *
 * It stands in for the library's `RabbitMQModule`, which keeps its connections and a
 * "handlers are registered" flag in static fields: one application per Node process. The e2e
 * suite runs the api and the worker as two applications in one process, where the second one
 * would get no consumer and closing either would close both.
 *
 * A process consumes only what its entrypoint imports: the api graph has no decorated class,
 * so nothing is registered there (test/architecture/process-graph.spec.ts).
 *
 * It is the entry of every message: a delivery is handled in a scope of its own, under the
 * correlation id of the message, and leaves one line in the log (docs/adr/0023) and one
 * observation in the metrics (docs/adr/0027).
 */
@Injectable()
export class RabbitSubscribers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log: Logger;
  // a property: the constructor is at the limit of six (quality/code-style.md §2)
  @Inject(METRICS) private readonly metrics!: Metrics;
  private meters!: BrokerMeters;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly connection: AmqpConnection,
    @Inject(rabbitConfig.KEY) private readonly config: RabbitConfig,
    private readonly correlation: CorrelationContext,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: RabbitSubscribers.name });
  }

  async onApplicationBootstrap(): Promise<void> {
    this.meters = brokerMeters(this.metrics);
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null) continue;
      await this.subscribeAll(wrapper.name as string, instance as Methods);
    }
  }

  /** Stops consuming, waits for the handlers that are running, then closes. */
  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }

  private async subscribeAll(provider: string, instance: Methods): Promise<void> {
    const prototype = Object.getPrototypeOf(instance) as object | null;
    if (!prototype) return;
    for (const name of this.scanner.getAllMethodNames(prototype)) {
      const config = subscription(instance[name]);
      if (config) await this.subscribe(provider, instance, name, config);
    }
  }

  /**
   * The decorator names the exchange, the routing keys and the queue. What a failed message
   * does is the same for every queue and comes from the configuration, so it is added here:
   * the queue's arguments, its wait, dead-letter and delay queues, and the error handler.
   */
  private async subscribe(
    provider: string,
    instance: Methods,
    name: string,
    config: RabbitHandlerConfig,
  ): Promise<void> {
    const { queue } = config;
    const policy = queue === undefined ? undefined : this.config.retry[queue];
    if (queue === undefined || policy === undefined) {
      throw new Error(
        `${provider}.${name}: queue ${queue ?? '(unnamed)'} has no retry policy (rabbitConfig.retry)`,
      );
    }

    // as a setup of the channel: declared again when the connection comes back
    await this.connection.managedChannel.addSetup((channel: ConfirmChannel) =>
      declareRetryQueues(channel, queue, policy),
    );
    // a queue that is the reader of delayed messages gets its delay queues beside it
    const delays = this.config.delays[queue];
    if (delays !== undefined) {
      await this.connection.managedChannel.addSetup((channel: ConfirmChannel) =>
        declareDelayQueues(channel, queue, delays),
      );
    }
    const subscription = { instance, name, queue, policy };
    await this.connection.createSubscriber(
      async (message, raw) => {
        await this.correlation.run(correlationOf(raw, message), () =>
          this.deliver(subscription, message, raw),
        );
        return undefined;
      },
      {
        ...config,
        queueOptions: workQueueOptions(queue, policy),
        errorHandler: retryOrPark(queue, policy, {
          logger: this.log,
          correlation: this.correlation,
          meters: this.meters,
        }),
        // bytes that are not JSON reach the handler as a string and fail its contract check,
        // like every other message that is not a contract
        allowNonJsonMessages: true,
      },
      name,
    );
    const handler = `${provider}.${name}`;
    const { maxAttempts, delayMs: retryDelayMs } = policy;
    this.log.info(
      { handler, exchange: config.exchange, queue, maxAttempts, retryDelayMs },
      'subscribed',
    );
  }

  /** One delivery to its handler, and its line (ops/logging.md §3). What it throws is thrown on. */
  private async deliver(
    { instance, name, queue, policy }: Subscription,
    message: unknown,
    raw: ConsumeMessage | undefined,
  ): Promise<void> {
    const delivery = deliveryOf(raw, queue, policy);
    const startedAt = performance.now();
    const line = (outcome: 'ok' | 'failed') => ({
      queue,
      routingKey: raw?.fields.routingKey,
      messageId: raw?.properties.messageId as unknown,
      attempt: delivery.attempt,
      durationMs: Math.round(performance.now() - startedAt),
      outcome,
    });
    try {
      // A message that kills its consumer never reaches an error handler, so the count of
      // the broker is the only one there is. Checked before the handler, and below the
      // limit of the broker itself: what the broker dead-letters at its own limit cannot
      // return from the wait queue (a cycle without a rejection) and stays there.
      const returned = redeliveries(raw);
      if (returned >= this.config.redeliveryLimit) {
        throw new UnprocessableMessageError(
          `taken back from a consumer ${String(returned)} times (redelivery limit)`,
        );
      }
      await instance[name]?.call(instance, message, delivery);
    } catch (err: unknown) {
      // the error is logged by what settles the message (retry-or-park.ts)
      this.meters.delivered(queue, 'failed', startedAt);
      this.log.info(line('failed'), 'message delivered');
      throw err;
    }
    this.meters.delivered(queue, 'ok', startedAt);
    this.log.info(line('ok'), 'message delivered');
  }
}
