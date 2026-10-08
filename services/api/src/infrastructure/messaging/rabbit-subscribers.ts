import { AmqpConnection, RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { rabbitConfig } from '@config/configuration';
import type { RabbitConfig } from '@config/configuration';
import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';
import type { Delivery } from '@shared/messaging/delivery';

import { declareDelayQueues } from './delay-topology';
import { deliveryOf, retryOrPark } from './retry-or-park';
import { declareRetryQueues, redeliveries, workQueueOptions } from './retry-topology';

import type { RabbitHandlerConfig } from '@golevelup/nestjs-rabbitmq';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { ConfirmChannel } from 'amqplib';

/** A `@RabbitSubscribe` method: the body of the message, and which delivery of it this is. */
type Handler = (message: unknown, delivery: Delivery) => Promise<unknown>;
type Methods = Record<string, Handler | undefined>;

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
 */
@Injectable()
export class RabbitSubscribers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitSubscribers.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly connection: AmqpConnection,
    @Inject(rabbitConfig.KEY) private readonly config: RabbitConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
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
    await this.connection.createSubscriber(
      async (message, raw) => {
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
        await instance[name]?.call(instance, message, deliveryOf(raw, queue, policy));
        return undefined;
      },
      {
        ...config,
        queueOptions: workQueueOptions(queue, policy),
        errorHandler: retryOrPark(queue, policy, this.logger),
        // bytes that are not JSON reach the handler as a string and fail its contract check,
        // like every other message that is not a contract
        allowNonJsonMessages: true,
      },
      name,
    );
    this.logger.log(
      `${provider}.${name} ← ${config.exchange ?? ''} → ${queue} ` +
        `(${String(policy.maxAttempts)} deliveries, ${String(policy.delayMs)} ms apart)`,
    );
  }
}
