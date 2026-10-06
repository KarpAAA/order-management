import { RabbitMQContainer } from '@testcontainers/rabbitmq';

import type { StartedRabbitMQContainer } from '@testcontainers/rabbitmq';

const MANAGEMENT_PORT = 15672;
// the image's default user; it may connect from outside the container
const USER = 'guest';
const AUTH = `Basic ${Buffer.from(`${USER}:${USER}`).toString('base64')}`;

/** Throwaway broker for one run, with the management API: test files create vhosts through it. */
export function startRabbit(): Promise<StartedRabbitMQContainer> {
  return new RabbitMQContainer('rabbitmq:4-management').withExposedPorts(MANAGEMENT_PORT).start();
}

export function rabbitManagementUrl(container: StartedRabbitMQContainer): string {
  return `http://${container.getHost()}:${container.getMappedPort(MANAGEMENT_PORT)}`;
}

async function management(apiUrl: string, method: string, path: string, body?: object) {
  const response = await fetch(new URL(`/api/${path}`, apiUrl), {
    method,
    headers: { authorization: AUTH, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`RabbitMQ ${method} ${path} answered ${response.status}`);
  }
}

/**
 * A vhost is the broker's namespace: its own exchanges, queues and messages. One per test
 * file, as each file has its own database, so a consumer in one file never takes the
 * messages of another. Returns the URL an app connects with.
 */
export async function createVhost(apiUrl: string, amqpUrl: string, name: string): Promise<string> {
  await management(apiUrl, 'PUT', `vhosts/${name}`);
  await management(apiUrl, 'PUT', `permissions/${name}/${USER}`, {
    configure: '.*',
    write: '.*',
    read: '.*',
  });
  const url = new URL(amqpUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Drops the vhost with everything in it; open connections to it are closed by the broker. */
export function dropVhost(apiUrl: string, name: string): Promise<void> {
  return management(apiUrl, 'DELETE', `vhosts/${name}`);
}
