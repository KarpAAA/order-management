import { Injectable } from '@nestjs/common';
import { map } from 'rxjs';

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

const hasId = (body: unknown): body is { id: string } =>
  typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'string';

/**
 * Sets `Location` on 201 and 202 from the returned `{ id }`, so controllers never touch the
 * response: 201 → `<collection>/<id>`, 202 (an action) → the resource the action ran on.
 */
@Injectable()
export class LocationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    return next.handle().pipe(
      map((body: unknown) => {
        const res = http.getResponse<Response>();
        if (!hasId(body) || (res.statusCode !== 201 && res.statusCode !== 202)) return body;
        const path = http.getRequest<Request>().path.replace(/\/+$/, '');
        const location =
          res.statusCode === 201 ? `${path}/${body.id}` : path.slice(0, path.lastIndexOf('/'));
        res.setHeader('Location', location);
        return body;
      }),
    );
  }
}
