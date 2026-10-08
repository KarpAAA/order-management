import { Injectable } from '@nestjs/common';
import { map } from 'rxjs';

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

/**
 * For an action that is usually done when it returns and sometimes only asked for: the
 * handler returns nothing when it is done (its `@HttpCode(204)` stands) and a body when the
 * work goes on, which makes the answer 202. The controller never touches the response, and
 * `LocationInterceptor`, which runs after this one, adds `Location` to the 202.
 */
@Injectable()
export class AcceptedWhenPendingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((body: unknown) => {
        if (body !== undefined) res.status(202);
        return body;
      }),
    );
  }
}
