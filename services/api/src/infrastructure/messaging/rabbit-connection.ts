import { AmqpConnection, MessageHandlerErrorBehavior } from '@golevelup/nestjs-rabbitmq';
import { Logger } from '@nestjs/common';
import { exchanges } from '@oms/contracts';

import type { RabbitConfig } from '@config/configuration';

/**
 * One connection per process, with the exchanges every service agrees on (`@oms/contracts`).
 * Queues are declared by the consumer that reads them (`@RabbitSubscribe`).
 */
export async function connectRabbit(config: RabbitConfig): Promise<AmqpConnection> {
  const connection = new AmqpConnection({
    uri: config.url,
    exchanges: Object.values(exchanges).map(({ name, type }) => ({ name, type })),
    // boot fails when the broker is not there: a process that cannot publish must not serve
    connectionInitOptions: { wait: true, timeout: 10_000, reject: true },
    // a message survives a broker restart, together with its durable queue
    defaultPublishOptions: { persistent: true },
    // A handler that throws rejects its message; the library's default puts it back at once,
    // which is a hot loop on a message that fails every time. Delayed retries and the
    // dead-letter queue are ROADMAP 3.3; until then a rejected message is lost.
    defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.NACK,
    // no request/reply between the services: commands are answered by events
    enableDirectReplyTo: false,
    logger: new Logger('RabbitMQ'),
  });
  await connection.init();
  return connection;
}
