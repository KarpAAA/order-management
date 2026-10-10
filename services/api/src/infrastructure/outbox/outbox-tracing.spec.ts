import { beforeEach, describe, expect, it } from 'vitest';

import { CorrelationContext } from '@common/messaging/correlation-context';
import { activeTraceId, recordingTracer } from '@common/tracing/__test__/recording-tracer';
import { inSpan, TRACE_LINK_HEADER } from '@common/tracing/trace-context';
import type { OutboxConfig } from '@config/configuration';
import type { PrismaService } from '@infra/database/prisma.service';
import { silentLogger } from '@shared/logger/silent-logger';

import { Outbox } from './outbox';
import { OutboxRelay } from './outbox-relay';
import { RabbitOutboxPublisher } from './rabbit-outbox.publisher';

import type { OutboxRecord } from './outbox-publisher.port';
import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

const tracing = recordingTracer();
beforeEach(() => {
  tracing.reset();
});

const message = {
  messageId: '01990000-0000-7000-8000-e00000000001',
  name: 'inventory.reserve-stock',
  occurredAt: '2026-10-12T10:00:00.000Z',
  correlationId: '01990000-0000-7000-8000-e00000000002',
};

/** The table, as `Outbox` writes it and the relay reads it. */
function outboxTable() {
  const rows: OutboxRecord[] = [];
  const tx = {
    outboxMessage: {
      create: ({ data }: { data: OutboxRecord }) => Promise.resolve(rows.push(data)),
      updateMany: () => Promise.resolve({ count: 0 }),
    },
    // the lock, then the batch
    $queryRaw: (sql: TemplateStringsArray) =>
      Promise.resolve(sql.join('').includes('pg_try_advisory') ? [{ locked: true }] : rows),
  };
  const txHost = { isTransactionActive: () => true, tx };
  const prisma = { $transaction: (work: (t: typeof tx) => unknown) => work(tx) };
  return { rows, outbox: new Outbox(txHost as never), prisma: prisma as unknown as PrismaService };
}

/** A relay over the table that tells in which trace it published each row. */
function relayOver(prisma: PrismaService) {
  const published: { traceId: string | undefined; record: OutboxRecord }[] = [];
  const cls = { run: (work: () => unknown) => work(), set: () => undefined };
  const relay = new OutboxRelay(
    prisma,
    { now: () => new Date() },
    {
      publish: (record) => {
        published.push({ traceId: activeTraceId(), record });
        return Promise.resolve();
      },
    },
    { batchSize: 10, publishTimeoutMs: 1000 } as OutboxConfig,
    new CorrelationContext(cls as never),
    silentLogger,
  );
  return { relay, published };
}

describe('the outbox carries the trace of what it holds (docs/adr/0025)', () => {
  it('TRC-010 a row is published in the trace of the request that wrote it', async () => {
    const { rows, outbox, prisma } = outboxTable();
    const requestTraceId = await inSpan('request', async (span) => {
      await outbox.append({ exchange: 'commands', message });
      return span.spanContext().traceId;
    });
    expect(rows[0]?.traceContext?.traceparent).toContain(requestTraceId);

    const { relay, published } = relayOver(prisma);
    await relay.pass();

    expect(published.map((p) => p.traceId)).toEqual([requestTraceId]);
  });

  it('TRC-011 a row written outside a trace is published outside one', async () => {
    const { rows, outbox, prisma } = outboxTable();
    await outbox.append({ exchange: 'commands', message });
    expect(rows[0]).not.toHaveProperty('traceContext');

    const { relay, published } = relayOver(prisma);
    await relay.pass();

    expect(published.map((p) => p.traceId)).toEqual([undefined]);
  });

  it('TRC-012 a delayed message points at its trace and does not continue it', async () => {
    const { rows, outbox, prisma } = outboxTable();
    const requestTraceId = await inSpan('request', async (span) => {
      await outbox.appendDelayed({ queue: 'api.saga-timeouts', delayMs: 600_000, message });
      return span.spanContext().traceId;
    });
    expect(rows[0]?.traceContext).not.toHaveProperty('traceparent');

    const { relay, published } = relayOver(prisma);
    await relay.pass();

    expect(published[0]?.traceId).toBeUndefined();
    expect(published[0]?.record.traceContext?.link).toContain(requestTraceId);
  });

  it('TRC-013 the publisher names the linked trace in a header, and only then', async () => {
    const sent: Record<string, unknown>[] = [];
    const channel = {
      publish: (_e: string, _k: string, _c: Buffer, options: Record<string, unknown>) => {
        sent.push(options);
        return Promise.resolve(true);
      },
    };
    const amqp = { managedConnection: { createChannel: () => channel } };
    const publisher = new RabbitOutboxPublisher(
      amqp as unknown as AmqpConnection,
      { publishTimeoutMs: 1000 } as OutboxConfig,
    );
    const row = { id: message.messageId, exchange: 'events', routingKey: 'q', payload: message };
    const link = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

    await publisher.publish({ ...row, traceContext: { link } });
    await publisher.publish({ ...row, traceContext: { traceparent: link } });
    await publisher.publish(row);

    expect(sent[0]?.headers).toEqual({ [TRACE_LINK_HEADER]: link });
    expect(sent[1]).not.toHaveProperty('headers');
    expect(sent[2]).not.toHaveProperty('headers');
  });
});
