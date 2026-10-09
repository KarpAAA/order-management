import { Injectable } from '@nestjs/common';

import { PrismaService } from '@infra/database/prisma.service';

/**
 * Retention of the idempotency keys (data/db-general.md §9): a key is kept for as long as
 * its request may still be retried, then deleted. The unscoped client: a key belongs to a
 * user, not to a tenant.
 */
@Injectable()
export class IdempotencyCleanup {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns how many keys went. */
  async deleteCreatedBefore(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return count;
  }
}
