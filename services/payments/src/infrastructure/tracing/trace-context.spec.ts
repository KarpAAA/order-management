import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { beforeAll, describe, expect, it } from 'vitest';

import { captureTraceContext, runInTraceContext, traceCarrierFrom } from './trace-context';

// what the SDK registers in a process (src/instrumentation.ts), in the memory of the test
beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider());
  propagation.setGlobalPropagator({
    inject: (ctx, carrier: Record<string, string>) => {
      const span = trace.getSpanContext(ctx);
      if (span) carrier.traceparent = `00-${span.traceId}-${span.spanId}-01`;
    },
    extract: (ctx, carrier: Record<string, string>) => {
      const [, traceId, spanId] = (carrier.traceparent ?? '').split('-');
      if (!traceId || !spanId) return ctx;
      return trace.setSpanContext(ctx, { traceId, spanId, traceFlags: 1, isRemote: true });
    },
    fields: () => ['traceparent'],
  });
});

const activeTraceId = (): string | undefined => trace.getSpanContext(context.active())?.traceId;

describe('the trace a row carries (docs/adr/0025)', () => {
  it('TRC-001 captures nothing outside a trace', () => {
    expect(captureTraceContext()).toBeNull();
  });

  it('TRC-002 work run in a captured context continues the trace that captured it', () => {
    const written = trace.getTracer('test').startActiveSpan('message', (span) => {
      const carrier = captureTraceContext();
      span.end();
      return { carrier, traceId: span.spanContext().traceId };
    });
    expect(written.carrier?.traceparent).toContain(written.traceId);

    // later, from a timer: no trace is under way
    expect(activeTraceId()).toBeUndefined();
    expect(runInTraceContext(written.carrier, activeTraceId)).toBe(written.traceId);
  });

  it('TRC-004 reads a carrier back from JSON, and takes anything else for no trace', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

    expect(traceCarrierFrom({ traceparent, other: 1 })).toEqual({ traceparent });
    for (const value of [null, undefined, 'x', 7, {}, { traceparent: 5 }, { traceparent: '' }]) {
      expect(traceCarrierFrom(value)).toBeNull();
    }
    expect(runInTraceContext(null, () => 'as it is')).toBe('as it is');
  });
});
