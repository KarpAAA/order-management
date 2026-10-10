import { describe, expect, it } from 'vitest';

import type { LoggingConfig } from '@config/configuration';

import { createPinoLogger } from './pino.logger';

/** An error of ours: a name, a code a client branches on, and details. */
class OutOfStock extends Error {
  readonly code = 'OUT_OF_STOCK';

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OutOfStock';
  }
}

/** The logger writing to memory: what a line is, as the collector of the logs reads it. */
function logger(
  config: Partial<LoggingConfig> = {},
  correlationId: () => string | undefined = () => undefined,
) {
  const written: Record<string, unknown>[] = [];
  const log = createPinoLogger({
    config: { level: 'info', pretty: false, ...config },
    base: { service: 'inventory' },
    correlationId,
    destination: { write: (line) => written.push(JSON.parse(line) as Record<string, unknown>) },
  });
  return { log, written };
}

describe('the pino logger (ops/logging.md §1)', () => {
  it('LOG-001 writes one JSON line: the level by name, the time, who wrote it, the fields, the message', () => {
    const { log, written } = logger();

    log.info({ orderId: 'o-1', durationMs: 12 }, 'order placed');

    expect(written).toEqual([
      {
        level: 'info',
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
        service: 'inventory',
        orderId: 'o-1',
        durationMs: 12,
        msg: 'order placed',
      },
    ]);
  });

  it('LOG-002 adds the correlation id of the work under way to every line, and none outside a chain', () => {
    const chain: { id?: string } = {};
    const { log, written } = logger({}, () => chain.id);

    log.info({}, 'outside');
    chain.id = 'c-1';
    log.info({}, 'inside');
    log.child({ context: 'Relay' }).warn({}, 'inside, from a child');

    expect(written.map((line) => line.correlationId)).toEqual([undefined, 'c-1', 'c-1']);
    expect(written[0]).not.toHaveProperty('correlationId');
  });

  it('writes the bindings of a child on each of its lines', () => {
    const { log, written } = logger();

    log.child({ context: 'OutboxRelay' }).info({ published: 3 }, 'pass done');

    expect(written[0]).toMatchObject({ context: 'OutboxRelay', published: 3, msg: 'pass done' });
  });

  it('LOG-004 writes nothing below the configured level', () => {
    const { log, written } = logger({ level: 'warn' });

    log.debug({}, 'query');
    log.info({}, 'use case');
    log.warn({}, 'refused');
    log.error({}, 'failed');

    expect(written.map((line) => line.level)).toEqual(['warn', 'error']);
  });

  it('LOG-005 serializes an error under `err`: its type, message, stack, and the code of ours', () => {
    const { log, written } = logger();

    log.error({ err: new OutOfStock('no stock for p-1', { productId: 'p-1' }) }, 'request failed');

    expect(written[0]?.err).toMatchObject({
      type: 'OutOfStock',
      message: 'no stock for p-1',
      stack: expect.stringContaining('OutOfStock: no stock for p-1'),
      code: 'OUT_OF_STOCK',
      details: { productId: 'p-1' },
    });
  });

  it.each([
    ['a field', { password: 'hunter2', token: 't', email: 'ann@example.test' }],
    [
      'a field of a field',
      { user: { email: 'ann@example.test' }, headers: { authorization: 'Bearer x' } },
    ],
    ['one below', { err: { details: { email: 'ann@example.test', apiKey: 'k' } } }],
    ['a header with a dash', { headers: { 'set-cookie': 'sid=1', cookie: 'sid=1' } }],
  ])('LOG-006 never writes a secret or an address, as %s', (_depth, fields) => {
    const { log, written } = logger();

    log.info(fields, 'anything');

    const line = JSON.stringify(written[0]);
    for (const secret of ['hunter2', 'ann@example.test', 'Bearer x', 'sid=1', '"t"', '"k"']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('[redacted]');
  });

  it('keeps what is not a secret beside what is', () => {
    const { log, written } = logger();

    log.info({ user: { id: 'u-1', email: 'ann@example.test' } }, 'anything');

    expect(written[0]?.user).toEqual({ id: 'u-1', email: '[redacted]' });
  });
});
