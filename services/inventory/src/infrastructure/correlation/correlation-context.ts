import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import type { Correlation } from '@shared/messaging/correlation';

const CORRELATION_ID = Symbol('messaging.correlationId');

/** The correlation id of the message under way, held in CLS (the port `CORRELATION`). */
@Injectable()
export class CorrelationContext implements Correlation {
  constructor(private readonly cls: ClsService) {}

  current(): string | undefined {
    return this.cls.isActive() ? this.cls.get<string | undefined>(CORRELATION_ID) : undefined;
  }

  continue(correlationId: string): void {
    this.cls.set(CORRELATION_ID, correlationId);
  }

  run<T>(correlationId: string, work: () => T): T {
    return this.cls.run(() => {
      this.cls.set(CORRELATION_ID, correlationId);
      return work();
    });
  }
}
