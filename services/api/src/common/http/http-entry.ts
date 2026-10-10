import { AsyncResource } from 'node:async_hooks';

import { actorRef } from '@shared/auth/actor';
import { newId } from '@shared/domain/id';
import type { Logger } from '@shared/logger/logger';
import { secondsSince, type Metrics } from '@shared/observability/metrics';

import { startCorrelation } from '../messaging/correlation-context';
import { CORRELATION_HEADER, correlationIdFrom } from '../messaging/correlation-header';

import type { RequestWithActor } from '../decorators/current-actor.decorator';
import type { Response } from 'express';
import type { ClsService } from 'nestjs-cls';

/**
 * What every HTTP request begins with, as the `setup` of the CLS middleware: the first thing
 * that runs in the scope of a request.
 *
 *  - the correlation id: the `x-correlation-id` of the caller when it is a UUID, a new one
 *    otherwise, and the same header on the answer, so that a client can name its request;
 *  - the line of the request (ops/logging.md §3), once, when the answer has been sent: the
 *    route as its pattern, never the URL with its ids, and never a header or a body;
 *  - its observation in `http_request_duration_seconds` (ops/observability.md §1), at the
 *    same moment and with the same route: rate, errors and duration are read from that one
 *    histogram.
 *
 * Here and not in an interceptor: a request a guard refuses, or one that matches no route,
 * is a request too.
 */
export function httpEntry(logger: Logger, metrics: Metrics) {
  const log = logger.child({ context: 'Http' });
  const duration = metrics.histogram({
    name: 'http_request_duration_seconds',
    help: 'Time from a request to its answer, by route pattern.',
    labels: ['method', 'route', 'status'],
  });
  return (cls: ClsService, req: RequestWithActor, res: Response): void => {
    const correlationId = correlationIdFrom(req.headers[CORRELATION_HEADER]) ?? newId();
    startCorrelation(cls, correlationId);
    res.setHeader(CORRELATION_HEADER, correlationId);

    const startedAt = performance.now();
    // bound: the event is emitted from the socket, outside the scope of the request
    const finished = AsyncResource.bind(() => {
      const route = routeOf(req);
      duration.observe(
        { method: req.method, route, status: res.statusCode },
        secondsSince(startedAt),
      );
      log.info(
        {
          method: req.method,
          route,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
          ...(req.actor === undefined ? {} : { actor: actorRef(req.actor) }),
        },
        'http request',
      );
    });
    res.once('finish', finished);
  };
}

/** The pattern the router matched (`/v1/workspaces/:workspaceId/orders`), or that none did. */
function routeOf(req: RequestWithActor): string {
  const route = req.route as { path?: unknown } | undefined;
  return typeof route?.path === 'string' ? route.path : 'unmatched';
}
