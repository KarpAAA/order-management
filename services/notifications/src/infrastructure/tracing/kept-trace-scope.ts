import { Injectable } from '@nestjs/common';

import type { TraceScope } from '@shared/tracing/trace-scope';

import { runInTraceContext, traceCarrierFrom } from './trace-context';

/** The port `TRACE_SCOPE` over the carrier of a row (`trace-context.ts`). */
@Injectable()
export class KeptTraceScope implements TraceScope {
  run<T>(kept: Readonly<Record<string, string>> | null, work: () => T): T {
    return runInTraceContext(traceCarrierFrom(kept), work);
  }
}
