import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { newId } from '@shared/domain/id';

const CORRELATION_ID = Symbol('messaging.correlationId');

/**
 * The correlation id of the current request, message or job, held in CLS: the same for every
 * message and every log line one piece of work causes (docs/adr/0023). An entry starts or
 * continues it: the HTTP middleware (the `x-correlation-id` of the request, or a new id), the
 * subscribers of the broker (the id of the message), a job (its own).
 */
@Injectable()
export class CorrelationContext {
  constructor(private readonly cls: ClsService) {}

  /** The id of the chain this work belongs to; the first call outside a chain starts one. */
  id(): string {
    if (!this.cls.isActive()) return newId();
    const known = this.cls.get<string | undefined>(CORRELATION_ID);
    if (known) return known;
    const started = newId();
    this.cls.set(CORRELATION_ID, started);
    return started;
  }

  /** The id of the chain, or `undefined` for work that belongs to none: what a log line gets. */
  current(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string | undefined>(CORRELATION_ID) : undefined;
  }

  /** A consumer, inside the scope of its message: what it causes belongs to that chain. */
  continue(correlationId: string): void {
    this.cls.set(CORRELATION_ID, correlationId);
  }

  /**
   * Runs `work` as a part of the chain `correlationId`, in a scope of its own: an entry that
   * has no scope yet (a message, a job, a row of the outbox). The scope inherits what the
   * caller's holds, a transaction included.
   */
  run<T>(correlationId: string, work: () => T): T {
    return this.cls.run(() => {
      this.cls.set(CORRELATION_ID, correlationId);
      return work();
    });
  }
}

/** For the CLS middleware, which has the store and no providers yet. */
export function startCorrelation(cls: ClsService, correlationId: string): void {
  cls.set(CORRELATION_ID, correlationId);
}
