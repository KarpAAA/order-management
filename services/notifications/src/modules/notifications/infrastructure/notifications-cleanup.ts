import { Injectable } from '@nestjs/common';

import { PrismaService } from '@infra/database/prisma.service';

/**
 * Retention of the notifications (data/db-general.md §9): one that was sent or given up is
 * kept for a while, as the record of what a user was told, then deleted: it holds an
 * address. One that still waits is never deleted here.
 */
@Injectable()
export class NotificationsCleanup {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns how many rows went. */
  async deleteSettledBefore(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.notification.deleteMany({
      where: { settledAt: { lt: cutoff } },
    });
    return count;
  }
}
