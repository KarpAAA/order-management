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

async function management(
  apiUrl: string,
  method: string,
  path: string,
  body?: object,
): Promise<Response> {
  const response = await fetch(new URL(`/api/${path}`, apiUrl), {
    method,
    headers: { authorization: AUTH, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error(`RabbitMQ ${method} ${path} answered ${String(response.status)}`);
  }
  return response;
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
export async function dropVhost(apiUrl: string, name: string): Promise<void> {
  await management(apiUrl, 'DELETE', `vhosts/${name}`);
}

interface BrokerConnection {
  name: string;
  client_properties?: { connection_name?: string };
}

/**
 * Closes, from the broker's side, the connections a client opened under `connectionName` in
 * the vhost: what the broker sees when a process is killed. Returns how many it closed; the
 * management API learns of a new connection a moment after it opens.
 */
export async function closeConnections(
  apiUrl: string,
  vhost: string,
  connectionName: string,
): Promise<number> {
  const response = await management(apiUrl, 'GET', `vhosts/${vhost}/connections`);
  const open = ((await response.json()) as BrokerConnection[]).filter(
    (connection) => connection.client_properties?.connection_name === connectionName,
  );
  for (const connection of open) {
    await management(apiUrl, 'DELETE', `connections/${encodeURIComponent(connection.name)}`);
  }
  return open.length;
}
