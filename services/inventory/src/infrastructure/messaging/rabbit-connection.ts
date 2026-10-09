import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Logger } from '@nestjs/common';
import { exchanges } from '@oms/contracts';

import type { RabbitConfig } from '@config/configuration';

export const CONNECTION_NAME = 'inventory-worker';

/**
 * One connection per process, with the exchanges every service agrees on (`@oms/contracts`).
 * Queues are declared by the consumer that reads them (`@RabbitSubscribe`); what happens to a
 * message whose handler throws is decided in `retry-or-park.ts`.
 */
export async function connectRabbit(config: RabbitConfig): Promise<AmqpConnection> {
  const connection = new AmqpConnection({
    uri: config.url,
    exchanges: Object.values(exchanges).map(({ name, type }) => ({ name, type })),
    // how many unacknowledged messages the broker hands this process: its concurrency
    prefetchCount: config.prefetch,
    // boot fails when the broker is not there: a consumer without a broker does nothing
    connectionInitOptions: { wait: true, timeout: 10_000, reject: true },
    // a message survives a broker restart, together with its durable queue
    defaultPublishOptions: { persistent: true },
    // shown in the management UI, next to the queues this process reads
    connectionManagerOptions: {
      connectionOptions: { clientProperties: { connection_name: CONNECTION_NAME } },
    },
    // no request/reply between the services: commands are answered by events
    enableDirectReplyTo: false,
    logger: new Logger('RabbitMQ'),
  });
  await connection.init();
  return connection;
}
