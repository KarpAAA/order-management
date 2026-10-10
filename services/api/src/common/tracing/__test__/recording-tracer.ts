import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

const exporter = new InMemorySpanExporter();
let registered = false;

/**
 * The tracing of a process, in the memory of a test: a real provider, the context manager and
 * the W3C propagator the SDK registers (src/instrumentation.ts), and the spans that ended.
 * Registered once per test file; `reset()` forgets the spans of the test before.
 */
export function recordingTracer() {
  if (!registered) {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
    registered = true;
  }
  return {
    spans: (): ReadableSpan[] => exporter.getFinishedSpans(),
    span: (name: string): ReadableSpan | undefined =>
      exporter.getFinishedSpans().find((span) => span.name === name),
    reset: (): void => {
      exporter.reset();
    },
  };
}

/** The trace id of the work under way, or `undefined` outside a trace. */
export const activeTraceId = (): string | undefined =>
  trace.getSpanContext(context.active())?.traceId;
