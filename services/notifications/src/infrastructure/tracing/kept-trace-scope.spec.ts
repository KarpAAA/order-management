import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { beforeAll, describe, expect, it } from 'vitest';

import { createPinoLogger } from '../logger/pino.logger';

import { KeptTraceScope } from './kept-trace-scope';

// what the SDK registers in a process (src/instrumentation.ts), in the memory of the test
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider());
  propagation.setGlobalPropagator({
    inject: () => undefined,
    extract: (ctx, carrier: Record<string, string>) => {
      const [, traceId, spanId] = (carrier.traceparent ?? '').split('-');
      if (!traceId || !spanId) return ctx;
      return trace.setSpanContext(ctx, { traceId, spanId, traceFlags: 1, isRemote: true });
    },
    fields: () => ['traceparent'],
  });
});

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

/** The logger of the process, writing to memory. */
function logger() {
  const written: Record<string, unknown>[] = [];
  const log = createPinoLogger({
    config: { level: 'info', pretty: false },
    base: { service: 'notifications' },
    correlationId: () => undefined,
    destination: { write: (line) => written.push(JSON.parse(line) as Record<string, unknown>) },
  });
  return { log, written };
}

describe('the trace a row kept, around what is said of it later (docs/adr/0026)', () => {
  it('LOG-054 a line written in the trace a row kept carries that trace, with no span under way', () => {
    const { log, written } = logger();
    // what the row kept of the span that wrote it, which has ended since
    const kept = { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` };

    new KeptTraceScope().run(kept, () => {
      log.info({}, 'mail sent');
    });

    expect(written[0]).toMatchObject({ traceId: TRACE_ID, spanId: SPAN_ID, msg: 'mail sent' });
  });

  it('LOG-054 a row that kept no trace gives its line none', () => {
    const { log, written } = logger();

    new KeptTraceScope().run(null, () => {
      log.info({}, 'mail sent');
    });

    expect(written[0]).not.toHaveProperty('traceId');
  });
});
