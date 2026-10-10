import { createServer, type Server } from 'node:http';

import { Inject, Injectable } from '@nestjs/common';

import { LOGGER, type Logger } from '@shared/logger/logger';

import { METRICS_PORT } from './observability.tokens';
import { PromMetrics } from './prom.metrics';

import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { AddressInfo } from 'node:net';

/**
 * Serves `GET /metrics` and nothing else, on `port` (0: one the system picks). A server of
 * its own, outside Nest: the worker has no HTTP application, and in the api the metrics must
 * not be on the public port, in Swagger, in the log of the requests or in their histogram.
 */
export function serveMetrics(metrics: PromMetrics, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metrics.expose().then(
      ({ contentType, body }) => {
        res.writeHead(200, { 'Content-Type': contentType }).end(body);
      },
      () => {
        res.writeHead(500).end();
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** The port a server listens on. */
export const portOf = (server: Server): number => (server.address() as AddressInfo).port;

/**
 * The metrics endpoint of the process (`metrics-endpoint: port`). Port 0 means none: the
 * tests read the registry directly, and several applications share one process there.
 */
@Injectable()
export class MetricsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log: Logger;
  private server: Server | undefined;

  constructor(
    private readonly metrics: PromMetrics,
    @Inject(METRICS_PORT) private readonly port: number,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.log = logger.child({ context: MetricsServer.name });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.port === 0) return;
    this.server = await serveMetrics(this.metrics, this.port);
    this.log.info({ port: this.port }, 'metrics served');
  }

  async onApplicationShutdown(): Promise<void> {
    const { server } = this;
    if (!server) return;
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
}
