import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { newId } from '@shared/domain/id';

const CORRELATION_ID = Symbol('messaging.correlationId');

/**
 * The correlation id of the current request or message, held in CLS: the same for every
 * message one piece of work causes. A consumer continues the id of the message it handles; an
 * HTTP request starts a new one (Step 4 takes the id of the request instead).
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

  /** A consumer, inside the scope of its message: what it causes belongs to that chain. */
  continue(correlationId: string): void {
    this.cls.set(CORRELATION_ID, correlationId);
  }
}
