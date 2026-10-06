import { AmqpConnection, RABBIT_HANDLER } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import type { RabbitHandlerConfig, SubscriberHandler } from '@golevelup/nestjs-rabbitmq';
import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

type Methods = Record<string, SubscriberHandler | undefined>;

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
      if (!config) continue;
      await this.connection.createSubscriber(
        (message, raw, headers) =>
          instance[name]?.call(instance, message, raw, headers) ?? Promise.resolve(),
        config,
        name,
      );
      this.logger.log(`${provider}.${name} ← ${config.exchange ?? ''} → ${config.queue ?? ''}`);
    }
  }
}
