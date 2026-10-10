import { context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';

/**
 * What a row keeps of the trace it was written in (docs/adr/0025): the W3C headers. Work
 * that waits in a table is done later by a timer, where the context of the message that
 * asked for it is gone: the row carries it, and whoever does the work continues the trace
 * as a child of the span that wrote the row. A copy of the api's, without the link of a
 * delayed message: this service has none.
 */
export interface TraceCarrier {
  traceparent: string;
  tracestate?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** A carrier read back from a JSON column: whatever is not one is no trace. */
export function traceCarrierFrom(value: unknown): TraceCarrier | null {
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Record<string, unknown>;
  const traceparent = text(fields.traceparent);
  const tracestate = text(fields.tracestate);
  if (!traceparent) return null;
  return { traceparent, ...(tracestate ? { tracestate } : {}) };
}

/** The trace of the work under way, to be continued later. `null` outside a trace. */
export function captureTraceContext(): TraceCarrier | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return traceCarrierFrom(carrier);
}

/** Runs `work` in the trace the carrier holds; with none kept, as it is. */
export function runInTraceContext<T>(carrier: TraceCarrier | null | undefined, work: () => T): T {
  if (!carrier) return work();
  return context.with(propagation.extract(ROOT_CONTEXT, { ...carrier }), work);
}
