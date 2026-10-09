import { Injectable } from '@nestjs/common';

import { PrismaService } from '@infra/database/prisma.service';

/**
 * Retention of the inbox (data/db-general.md §9): a row is kept for as long as its message
 * may still come again, then deleted. The unscoped client: the rows belong to no tenant.
 */
@Injectable()
export class InboxCleanup {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns how many rows went. */
  async deleteProcessedBefore(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.inboxMessage.deleteMany({
      where: { processedAt: { lt: cutoff } },
    });
    return count;
  }
}
