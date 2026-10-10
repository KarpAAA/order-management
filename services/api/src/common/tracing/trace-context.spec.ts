import { context } from '@opentelemetry/api';
import { isTracingSuppressed } from '@opentelemetry/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { activeTraceId, recordingTracer } from './__test__/recording-tracer';
import {
  captureTraceContext,
  captureTraceLink,
  inSpan,
  runInTraceContext,
  spanContextOf,
  traceCarrierFrom,
} from './trace-context';

const tracing = recordingTracer();
beforeEach(() => {
  tracing.reset();
});

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

describe('the trace a row carries (docs/adr/0025)', () => {
  it('TRC-001 captures nothing outside a trace', () => {
    expect(captureTraceContext()).toBeNull();
    expect(captureTraceLink()).toBeNull();
  });

  it('TRC-002 work run in a captured context is a child of the span that captured it', async () => {
    const written = await inSpan('request', (span) =>
      Promise.resolve({ carrier: captureTraceContext(), span: span.spanContext() }),
    );
    expect(written.carrier?.traceparent).toMatch(TRACEPARENT);

    // later, from a timer: no trace is under way
    expect(activeTraceId()).toBeUndefined();
    await runInTraceContext(written.carrier, () => inSpan('publish', () => Promise.resolve()));

    const publish = tracing.span('publish');
    expect(publish?.spanContext().traceId).toBe(written.span.traceId);
    expect(publish?.parentSpanContext?.spanId).toBe(written.span.spanId);
  });

  it('TRC-003 a link is not continued: the work is not traced and hands no context on', async () => {
    const link = await inSpan('request', () => Promise.resolve(captureTraceLink()));
    expect(link?.link).toMatch(TRACEPARENT);

    const seen = runInTraceContext(link, () => ({
      traceId: activeTraceId(),
      suppressed: isTracingSuppressed(context.active()),
    }));

    expect(seen).toEqual({ traceId: undefined, suppressed: true });
    expect(spanContextOf(link?.link)?.traceId).toBe(tracing.span('request')?.spanContext().traceId);
  });

  it('TRC-004 reads a carrier back from JSON, and takes anything else for no trace', () => {
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

    expect(traceCarrierFrom({ traceparent, other: 1 })).toEqual({ traceparent });
    expect(traceCarrierFrom({ link: traceparent })).toEqual({ link: traceparent });
    for (const value of [null, undefined, 'x', 7, {}, { traceparent: 5 }, { traceparent: '' }]) {
      expect(traceCarrierFrom(value)).toBeNull();
    }
    expect(spanContextOf('not a traceparent')).toBeUndefined();
    expect(runInTraceContext(null, () => 'as it is')).toBe('as it is');
  });
});
