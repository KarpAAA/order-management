import { PrismaPg } from '@prisma/adapter-pg';

import type { Metrics } from '@shared/observability/metrics';

import type { Pool, PoolConfig } from 'pg';

/** What a pool tells about itself; `pg.Pool` has all three. */
export type PoolCounts = Pick<Pool, 'totalCount' | 'idleCount' | 'waitingCount'>;

/**
 * The connection pool of the process as a gauge (docs/adr/0027): how many connections it
 * holds, how many are free, and how many queries wait for one. `waiting` above zero is the
 * pool being the bottleneck, which no exporter of the server can see: it happens in here.
 *
 * Answers with where to put the pool once there is one: before that, and after the client
 * disconnected, the gauge has no sample of this pool.
 */
export function measurePool(
  metrics: Metrics,
  name: 'primary' | 'replica',
): (pool: PoolCounts) => void {
  let pool: PoolCounts | undefined;
  metrics.gauge({
    name: 'db_pool_connections',
    help: 'Connections of the pool of this process, by state; waiting = queries without one.',
    labels: ['pool', 'state'],
    collect: () =>
      Promise.resolve(
        pool === undefined
          ? []
          : [
              { labels: { pool: name, state: 'total' }, value: pool.totalCount },
              { labels: { pool: name, state: 'idle' }, value: pool.idleCount },
              { labels: { pool: name, state: 'waiting' }, value: pool.waitingCount },
            ],
      ),
  });
  return (made) => {
    pool = made;
  };
}

/**
 * The adapter of Prisma, which also says which pool it made. The pool stays the adapter's:
 * it creates it when the client connects and ends it when the client disconnects, as it
 * always did. Handing the adapter a pool of ours would make its life ours too; this only
 * reads it.
 */
export class MeasuredPrismaPg extends PrismaPg {
  constructor(
    config: PoolConfig,
    private readonly made: (pool: PoolCounts) => void,
  ) {
    super(config);
  }

  override async connect(): ReturnType<PrismaPg['connect']> {
    const adapter = await super.connect();
    this.made(adapter.underlyingDriver());
    return adapter;
  }
}
