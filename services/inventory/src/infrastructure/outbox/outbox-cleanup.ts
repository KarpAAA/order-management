import { Injectable } from '@nestjs/common';

import { PrismaService } from '@infra/database/prisma.service';

/**
 * Retention of the outbox (data/db-general.md §9): a published row is kept for a while as the
 * record of what was sent and when, then deleted. An unpublished row is never deleted,
 * however old. The unscoped client: the rows belong to no tenant.
 */
@Injectable()
export class OutboxCleanup {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns how many rows went. */
  async deletePublishedBefore(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.outboxMessage.deleteMany({
      where: { publishedAt: { lt: cutoff } },
    });
    return count;
  }
}
