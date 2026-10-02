import { Injectable } from '@nestjs/common';
import { catchError, concatMap, from, throwError } from 'rxjs';

import type { RequestWithActor } from '@common/decorators/current-actor.decorator';
import { ReadSource } from '@infra/database/read-source';
import { ReplicaPrismaService } from '@infra/database/replica-prisma.service';

import { ReadYourWrites } from './read-your-writes';

import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Decides where the reads of a request go, by the kind of request and not by the query
 * (docs/adr/0009-read-replica-routing.md):
 *  - GET: the replica, unless the caller wrote a moment ago and the replica has not replayed
 *    it yet. What is read is shown to someone, and may lag.
 *  - anything else: the primary, since what it reads ends up in a write. After the handler,
 *    and before the response leaves, the caller is marked as a writer — on an error too: a
 *    request that failed after its commit still wrote.
 * A request without an actor (`@Public()`) is left on the primary.
 */
@Injectable()
export class ReadRoutingInterceptor implements NestInterceptor {
  constructor(
    private readonly replica: ReplicaPrismaService,
    private readonly source: ReadSource,
    private readonly readYourWrites: ReadYourWrites,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (!this.replica.enabled || context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const userId = request.actor?.userId;
    if (!userId) return next.handle();

    if (SAFE_METHODS.has(request.method)) {
      if (await this.readYourWrites.replicaIsCurrentFor(userId)) this.source.allowReplica();
      return next.handle();
    }

    const recordWrite = () => this.readYourWrites.recordWrite(userId);
    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        await recordWrite();
        return body;
      }),
      catchError((error: unknown) =>
        from(recordWrite()).pipe(concatMap(() => throwError(() => error))),
      ),
    );
  }
}
