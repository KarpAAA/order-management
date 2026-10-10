import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

import type { Span, SpanContext, Tracer } from '@opentelemetry/api';

/**
 * What a row keeps of the trace it was written in (docs/adr/0025). Work that waits in a
 * table is done later by a timer of another process, where the context of the request is
 * gone: the row carries it.
 *
 *  - `traceparent` (and `tracestate`): the W3C headers. Whoever does the work continues the
 *    trace, as a child of the span that wrote the row;
 *  - `link`: a `traceparent` too, but the work starts a trace of its own that only points
 *    back at this one. For work that is due much later (a timeout of the saga).
 */
export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
  link?: string;
}

/** The header a message carries when its trace is a link, not a parent. */
export const TRACE_LINK_HEADER = 'x-trace-link';

/** Every manual span of this service comes from here. A no-op without the SDK. */
export const tracer = (): Tracer => trace.getTracer('oms');

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Runs `work` as a span of its own, a child of the span under way, and ends it. The work
 * that throws ends it too; whether that is an error of the span is said by `work`, which
 * knows what it threw (a refusal of the business is not one).
 */
export function inSpan<T>(name: string, work: (span: Span) => Promise<T>): Promise<T> {
  return tracer().startActiveSpan(name, async (span) => {
    try {
      return await work(span);
    } finally {
      span.end();
    }
  });
}

/** Marks the span as failed by `err`: what a trace shows in red. */
export function failSpan(span: Span, err: unknown): void {
  span.recordException(err instanceof Error ? err : new Error(String(err)));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

/** A carrier read back from a JSON column, or from the data of a job. */
export function traceCarrierFrom(value: unknown): TraceCarrier | null {
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Record<string, unknown>;
  const traceparent = text(fields.traceparent);
  const tracestate = text(fields.tracestate);
  const link = text(fields.link);
  if (!traceparent && !link) return null;
  return {
    ...(traceparent ? { traceparent } : {}),
    ...(tracestate ? { tracestate } : {}),
    ...(link ? { link } : {}),
  };
}

/** The trace of the work under way, to be continued later. `null` outside a trace. */
export function captureTraceContext(): TraceCarrier | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return traceCarrierFrom(carrier);
}

/** The trace of the work under way, to be pointed at later. `null` outside a trace. */
export function captureTraceLink(): TraceCarrier | null {
  const { traceparent } = captureTraceContext() ?? {};
  return traceparent ? { link: traceparent } : null;
}

/** The span a `traceparent` names, for a link to it. */
export function spanContextOf(traceparent: unknown): SpanContext | undefined {
  if (!text(traceparent)) return undefined;
  return trace.getSpanContext(propagation.extract(ROOT_CONTEXT, { traceparent }));
}

/**
 * Runs `work` in the trace the carrier holds.
 *  - a parent: its spans are children of the span that wrote the row;
 *  - a link: nothing is traced here, and the context is not handed on. The trace begins
 *    where the work is taken up, and the link is added there;
 *  - nothing kept: as it is.
 */
export function runInTraceContext<T>(carrier: TraceCarrier | null | undefined, work: () => T): T {
  if (carrier?.traceparent) {
    const { traceparent, tracestate } = carrier;
    const parent = propagation.extract(ROOT_CONTEXT, {
      traceparent,
      ...(tracestate ? { tracestate } : {}),
    });
    return context.with(parent, work);
  }
  if (carrier?.link) return context.with(suppressTracing(context.active()), work);
  return work();
}
