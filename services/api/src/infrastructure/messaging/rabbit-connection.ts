import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { exchanges } from '@oms/contracts';

import type { RabbitConfig } from '@config/configuration';
import type { Logger } from '@shared/logger/logger';
import { DELAYED_EXCHANGE } from '@shared/messaging/delayed';

import { NestLoggerAdapter } from '../logger/nest-logger.adapter';

/** The api process and the worker process each open one under this name. */
export const CONNECTION_NAME = 'api';

/**
 * One connection per process, with the exchanges every service agrees on (`@oms/contracts`)
 * and the one of this service for delayed messages (`delay-topology.ts`).
 * Queues are declared by the consumer that reads them (`@RabbitSubscribe`); what happens to a
 * message whose handler throws is decided in `retry-or-park.ts`.
 */
export async function connectRabbit(config: RabbitConfig, logger: Logger): Promise<AmqpConnection> {
  const connection = new AmqpConnection({
    uri: config.url,
    exchanges: [
      ...Object.values(exchanges).map(({ name, type }) => ({ name, type })),
      { name: DELAYED_EXCHANGE, type: 'direct' },
    ],
    // how many unacknowledged messages the broker hands this process: its concurrency
    prefetchCount: config.prefetch,
    // boot fails when the broker is not there: a process that cannot publish must not serve
    connectionInitOptions: { wait: true, timeout: 10_000, reject: true },
    // a message survives a broker restart, together with its durable queue
    defaultPublishOptions: { persistent: true },
    // shown in the management UI, next to the queues this process reads
    connectionManagerOptions: {
      connectionOptions: { clientProperties: { connection_name: CONNECTION_NAME } },
    },
    // no request/reply between the services: commands are answered by events
    enableDirectReplyTo: false,
    // the library asks for a Nest logger: its lines go through ours
    logger: new NestLoggerAdapter(logger.child({ context: 'RabbitMQ' })),
  });
  await connection.init();
  return connection;
}
