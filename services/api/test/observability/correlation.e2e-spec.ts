// The correlation id and the log of the api (LOG-030…035, docs/adr/0023): one id from the
// request to every command and event it causes, and on every line the api and the worker
// write about it. The apps log to memory (helpers/log-capture.ts), so a test reads the lines
// as the collector of the logs would. The other services are not here: the test is the other
// side of the broker and answers with the id of the command, as they do.
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orderFactory } from '../factories';
import { createApiApp, type ApiApp } from '../helpers/api-app';
import { asUser } from '../helpers/auth';
import { connectTestBroker, paymentSucceeded, type TestBroker } from '../helpers/broker';
import { orderPath } from '../helpers/paths';
import { waitFor, waitForStatus } from '../helpers/waiting';
import { createWorkerApp, type WorkerApp } from '../helpers/worker-app';
import { USER_ACME_MEMBER, WS_ACME } from '../seed/ids';

import type { LogLine } from '../helpers/log-capture';

const HEADER = 'x-correlation-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let api: ApiApp;
let worker: WorkerApp;
let broker: TestBroker;

beforeAll(async () => {
  // first: its queues must be bound before the api publishes anything
  broker = await connectTestBroker();
  api = await createApiApp();
  worker = await createWorkerApp();
});
afterAll(async () => {
  try {
    await worker.close();
  } finally {
    await api.close();
    await broker.close();
  }
});

const member = asUser(USER_ACME_MEMBER);

const place = (orderId: string) =>
  api
    .http()
    .post(`${orderPath(WS_ACME, orderId)}/place`)
    .set(member)
    .send({ version: 0 });

const about = (lines: LogLine[], correlationId: string) =>
  lines.filter((line) => line.correlationId === correlationId);

/** Until the app has written a line of the chain with this message and these fields. */
const logged = (
  app: { logs(): LogLine[] },
  correlationId: string,
  msg: string,
  fields: Record<string, unknown> = {},
) =>
  waitFor(
    () =>
      Promise.resolve(
        about(app.logs(), correlationId).filter(
          (line) =>
            line.msg === msg && Object.entries(fields).every(([key, value]) => line[key] === value),
        ),
      ),
    (lines) => lines.length > 0,
    { what: `a "${msg}" line of ${correlationId} with ${JSON.stringify(fields)}` },
  );

describe('one id from the request to the last message (LOG-030, LOG-031)', () => {
  const correlationId = uuidv7();
  let orderId: string;

  beforeAll(async () => {
    orderId = (await orderFactory.create()).id;
  });

  it('LOG-030 names the chain of the caller on the answer', async () => {
    const res = await place(orderId).set(HEADER, correlationId).expect(202);

    expect(res.headers[HEADER]).toBe(correlationId);
  });

  it('LOG-031 carries it in the command of every step of the saga, and in the events of the order', async () => {
    const [reserve] = await broker.waitForSent('inventory.reserve-stock', orderId);
    // inventory (the test broker) answered with the id of the command
    const [charge] = await broker.waitForCommands(orderId);
    // payments answers with the id of its command, too
    const answer = {
      ...paymentSucceeded({ workspaceId: WS_ACME, orderId, paymentAttempt: 1 }, 'ch_1'),
      correlationId,
    };
    await broker.publish(answer);
    await waitForStatus(api, orderPath(WS_ACME, orderId), member, ['PAID']);
    const events = await broker.waitForOrderEvents(orderId, 2);

    expect(reserve?.correlationId).toBe(correlationId);
    expect(charge?.correlationId).toBe(correlationId);
    expect(events.map(({ name, correlationId: id }) => [name, id])).toEqual([
      ['orders.order-placed', correlationId],
      ['orders.order-paid', correlationId],
    ]);
  });

  it('LOG-032 the api logs the request and its use case under that id', async () => {
    const [request] = await logged(api, correlationId, 'http request');
    const [useCase] = await logged(api, correlationId, 'use case');

    expect(request).toMatchObject({
      level: 'info',
      service: 'api',
      process: 'api',
      method: 'POST',
      route: '/v1/workspaces/:workspaceId/orders/:orderId/place',
      status: 202,
      actor: USER_ACME_MEMBER,
    });
    expect(useCase).toMatchObject({
      useCase: 'PlaceOrderService',
      actor: USER_ACME_MEMBER,
      outcome: 'ok',
    });
  });

  it('LOG-033 the worker logs every delivery and every step of the saga under that id', async () => {
    const delivered = async (queue: string) =>
      (await logged(worker, correlationId, 'message delivered', { queue }))[0];
    const ran = async (useCase: string) =>
      (await logged(worker, correlationId, 'use case', { useCase }))[0];

    expect(await delivered('api.inventory-events')).toMatchObject({
      service: 'api',
      process: 'worker',
      routingKey: 'inventory.stock-reserved',
      attempt: 1,
      outcome: 'ok',
    });
    expect(await delivered('api.payment-events')).toMatchObject({
      routingKey: 'payments.payment-succeeded',
      outcome: 'ok',
    });
    expect(await ran('ConfirmStockReservationService')).toMatchObject({ outcome: 'ok' });
    expect(await ran('CompleteOrderPaymentService')).toMatchObject({
      actor: 'system:consumer:orders',
      outcome: 'ok',
    });
  });

  it('keeps the chains of two requests apart', async () => {
    const other = (await orderFactory.create()).id;
    const otherId = uuidv7();

    await place(other).set(HEADER, otherId).expect(202);
    const [reserve] = await broker.waitForSent('inventory.reserve-stock', other);

    expect(reserve?.correlationId).toBe(otherId);
    expect(about(api.logs(), otherId).every((line) => line.correlationId !== correlationId)).toBe(
      true,
    );
  });
});

describe('a request that names no chain, or one that cannot be used (LOG-034)', () => {
  it.each([
    ['no header', undefined],
    ['a header that is not a UUID', 'my-request-42'],
  ])('starts a chain of its own with %s, and tells the caller its id', async (_case, header) => {
    const { id } = await orderFactory.create();
    const request = place(id);
    if (header !== undefined) void request.set(HEADER, header);

    const res = await request.expect(202);
    const started = res.headers[HEADER]!;
    const [reserve] = await broker.waitForSent('inventory.reserve-stock', id);

    expect(started).toMatch(UUID);
    expect(reserve?.correlationId).toBe(started);
  });
});

describe('what a refused request leaves in the log (LOG-035)', () => {
  it('logs a 4xx at warn with its code, under the id the caller was given', async () => {
    const res = await api.http().get(orderPath(WS_ACME, uuidv7())).set(member).expect(404);
    const correlationId = res.headers[HEADER]!;

    const lines = about(api.logs(), correlationId);

    expect(lines.find((line) => line.msg === 'request refused')).toMatchObject({
      level: 'warn',
      code: 'ORDER_NOT_FOUND',
      status: 404,
    });
    await logged(api, correlationId, 'http request', { status: 404 });
  });

  it('never writes the token of a caller, on any line', async () => {
    const [, token] = member.Authorization.split(' ');
    await api.http().get(orderPath(WS_ACME, uuidv7())).set(member).expect(404);

    expect(JSON.stringify(api.logs())).not.toContain(token);
  });
});
