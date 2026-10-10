/**
 * The trace a row kept, given back to what is done about that row later (docs/adr/0025,
 * 0026). An entry class that speaks for work a timer did (the line of a mail) has no span
 * of that work around it: it runs its words in the trace the row carries, so the line can
 * be found from the trace and the trace from the line.
 */
export interface TraceScope {
  /** Runs `work` in the trace `kept` holds; as it is when the row kept none. */
  run<T>(kept: Readonly<Record<string, string>> | null, work: () => T): T;
}

export const TRACE_SCOPE = Symbol('TRACE_SCOPE');
