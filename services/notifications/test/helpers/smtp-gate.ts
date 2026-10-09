// A mail server that can go away and come back without the service being restarted: a TCP
// port of the test's own in front of the run's Mailpit. Open, it passes every byte through;
// closed, it hangs up on whoever connects, which is what a server that is down looks like.
import { createConnection, createServer } from 'node:net';

import { inject } from 'vitest';

import type { AddressInfo, Server, Socket } from 'node:net';

export interface SmtpGate {
  /** Where the service under test must send: `127.0.0.1:<port>`. */
  port: number;
  /** Mails get through to the mail server again. */
  open(): void;
  /** Every connection is dropped, the ones under way included. */
  close(): void;
  stop(): Promise<void>;
}

export async function startSmtpGate(): Promise<SmtpGate> {
  let isOpen = true;
  const sockets = new Set<Socket>();

  const server: Server = createServer((client) => {
    if (!isOpen) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: inject('smtpHost'), port: inject('smtpPort') });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      // a peer that hung up is the point of this helper, not a failure of the test
      socket.on('error', () => undefined);
    }
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: (server.address() as AddressInfo).port,
    open: () => {
      isOpen = true;
    },
    close: () => {
      isOpen = false;
      for (const socket of sockets) socket.destroy();
    },
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
