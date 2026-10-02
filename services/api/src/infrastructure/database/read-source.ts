import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import type { ScopedPrismaClient } from './database.tokens';

const FROM_REPLICA = Symbol('read.fromReplica');

/**
 * Where the reads of the current request go, held in CLS. The primary unless the request was
 * allowed the replica, which happens in one place: `ReadRoutingInterceptor`, for a GET whose
 * caller has no write the replica is still missing. A mutating request, a job and anything
 * that never asked therefore read the primary.
 */
@Injectable()
export class ReadSource {
  constructor(private readonly cls: ClsService) {}

  fromReplica(): boolean {
    return this.cls.isActive() && this.cls.get<boolean | undefined>(FROM_REPLICA) === true;
  }

  allowReplica(): void {
    this.cls.set(FROM_REPLICA, true);
  }
}

/**
 * The read handle: looks like one tenant-scoped client and forwards every access to the
 * replica's or the primary's, decided per request by `source`. Query services keep calling
 * `db.order.findMany(...)` and never choose.
 */
export function createReadDb(
  primary: ScopedPrismaClient,
  replica: ScopedPrismaClient,
  source: ReadSource,
): ScopedPrismaClient {
  return new Proxy(primary, {
    get(_target, property) {
      const client = source.fromReplica() ? replica : primary;
      const value: unknown = Reflect.get(client, property);
      return typeof value === 'function' ? (value.bind(client) as unknown) : value;
    },
  });
}
