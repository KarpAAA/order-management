import { Inject, Injectable, Logger } from '@nestjs/common';

import { databaseConfig, type DatabaseConfig } from '@config/configuration';
import { PrismaService } from '@infra/database/prisma.service';
import { ReplicaPrismaService } from '@infra/database/replica-prisma.service';
import { RedisService } from '@infra/redis/redis.service';

/** Stored when the primary's position could not be read: the writer stays on the primary. */
const PINNED = 'pinned';

const markerKey = (userId: string) => `ryw:${userId}`;

/**
 * Read-your-writes on an asynchronous replica (docs/adr/0009-read-replica-routing.md).
 *
 * After a write the primary's WAL position (LSN) is stored for the writer, with a TTL. Before
 * a read the replica is asked whether it has replayed up to that position: if so it holds
 * everything the writer committed and may serve the read, otherwise the primary does. A user
 * with no marker has written nothing lately and reads the replica.
 */
@Injectable()
export class ReadYourWrites {
  private readonly logger = new Logger(ReadYourWrites.name);

  constructor(
    private readonly primary: PrismaService,
    private readonly replica: ReplicaPrismaService,
    private readonly redis: RedisService,
    @Inject(databaseConfig.KEY) private readonly config: DatabaseConfig,
  ) {}

  /** Never throws: a write that succeeded must not fail on its marker. */
  async recordWrite(userId: string): Promise<void> {
    try {
      await this.redis.set(
        markerKey(userId),
        await this.primaryPosition(),
        'EX',
        this.config.readYourWritesTtlSeconds,
      );
    } catch (error) {
      this.logger.warn(`No write marker for ${userId}, a stale read may follow: ${String(error)}`);
    }
  }

  /**
   * Whether the replica holds every write of `userId`. Redis not answering counts as yes: a
   * stale read is bounded harm, every read landing on the primary is not. A replica that does
   * not answer the position check counts as no: it would not answer the read either.
   */
  async replicaIsCurrentFor(userId: string): Promise<boolean> {
    let position: string | null;
    try {
      position = await this.redis.get(markerKey(userId));
    } catch (error) {
      this.logger.warn(`No write marker readable, reading the replica: ${String(error)}`);
      return true;
    }
    if (position === null) return true;
    if (position === PINNED) return false;
    try {
      const [row] = await this.replica.client.$queryRaw<{ replayed: boolean }[]>`
        SELECT pg_last_wal_replay_lsn() >= ${position}::pg_lsn AS replayed`;
      return row?.replayed === true;
    } catch (error) {
      this.logger.warn(`The replica did not answer, reading the primary: ${String(error)}`);
      return false;
    }
  }

  /**
   * The insert position, not the write position: it is never behind the commit record of the
   * transaction that just ended, even with `synchronous_commit = off`.
   */
  private async primaryPosition(): Promise<string> {
    try {
      const [row] = await this.primary.$queryRaw<{ lsn: string }[]>`
        SELECT pg_current_wal_insert_lsn()::text AS lsn`;
      return row?.lsn ?? PINNED;
    } catch {
      return PINNED;
    }
  }
}
