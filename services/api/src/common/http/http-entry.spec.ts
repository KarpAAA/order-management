import { EventEmitter } from 'node:events';

import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';

import { userActor } from '@shared/auth/actor';
import { RecordingLogger } from '@shared/logger/__test__/recording-logger';
import type { Logger } from '@shared/logger/logger';
import { silentLogger } from '@shared/logger/silent-logger';
import { silentMetrics } from '@shared/observability/silent-metrics';

import { CorrelationContext } from '../messaging/correlation-context';

import { httpEntry } from './http-entry';

import type { RequestWithActor } from '../decorators/current-actor.decorator';
import type { Response } from 'express';

const ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const cls = ClsServiceManager.getClsService();
const correlation = new CorrelationContext(cls);

/** One request through the entry, as the CLS middleware runs it: in a scope of its own. */
function request(headers: Record<string, unknown>, route?: string) {
  const logger = new RecordingLogger();
  const sent: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      sent[name] = value;
    },
  });
  const req = { method: 'POST', headers, ...(route ? { route: { path: route } } : {}) };
  const inScope = cls.run(() => {
    httpEntry(logger, silentMetrics)(
      cls,
      req as unknown as RequestWithActor,
      res as unknown as Response,
    );
    return correlation.current();
  });
  return { logger, sent, res, req: req as unknown as RequestWithActor, inScope };
}

describe('the entry of an HTTP request (LOG-010, LOG-021)', () => {
  it('continues the chain the caller named, and names it back on the answer', () => {
    const { sent, inScope } = request({ 'x-correlation-id': ID });

    expect(inScope).toBe(ID);
    expect(sent).toEqual({ 'x-correlation-id': ID });
  });

  it.each([
    ['sends none', {}],
    ['sends something that is not a UUID', { 'x-correlation-id': 'my-request' }],
  ])('starts a chain of its own when the caller %s', (_case, headers) => {
    const { sent, inScope } = request(headers);

    expect(inScope).toMatch(UUID);
    expect(sent['x-correlation-id']).toBe(inScope);
  });

  it('logs the request once, when the answer is sent: the route as its pattern, the status, the actor', () => {
    const { logger, res, req } = request({}, '/v1/workspaces/:workspaceId/orders/:orderId/place');
    expect(logger.lines).toEqual([]);

    // set by the guard and the handler, after the entry
    req.actor = userActor('u-1');
    res.statusCode = 202;
    res.emit('finish');

    expect(logger.lines).toEqual([
      {
        level: 'info',
        message: 'http request',
        fields: {
          context: 'Http',
          method: 'POST',
          route: '/v1/workspaces/:workspaceId/orders/:orderId/place',
          status: 202,
          durationMs: expect.any(Number),
          actor: 'u-1',
        },
      },
    ]);
  });

  it('logs a request no route matched, and one nobody was signed in for', () => {
    const { logger, res } = request({});

    res.statusCode = 404;
    res.emit('finish');

    expect(logger.lines[0]?.fields).toMatchObject({ route: 'unmatched', status: 404 });
    expect(logger.lines[0]?.fields).not.toHaveProperty('actor');
  });

  it('writes the line inside the chain of the request, though the event comes from outside it', () => {
    const seen: (string | undefined)[] = [];
    // a logger that asks for the correlation id when it writes, as the real one does
    const asking: Logger = {
      ...silentLogger,
      child: () => asking,
      info: () => void seen.push(correlation.current()),
    };
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: () => undefined });
    cls.run(() => {
      httpEntry(asking, silentMetrics)(
        cls,
        { method: 'GET', headers: { 'x-correlation-id': ID } } as unknown as RequestWithActor,
        res as unknown as Response,
      );
    });

    res.emit('finish');

    expect(seen).toEqual([ID]);
  });
});
