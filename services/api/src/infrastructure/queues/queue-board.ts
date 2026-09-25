import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { getQueueToken } from '@nestjs/bullmq';

import type { INestApplication } from '@nestjs/common';
import type { Queue } from 'bullmq';

export const QUEUE_BOARD_PATH = '/admin/queues';

/**
 * Mounts bull-board (dev only, enabled by `BULL_BOARD_ENABLED`). Unauthenticated: it is a
 * local debugging tool, and the config refuses to enable it in production.
 */
export function setupQueueBoard(app: INestApplication, queueNames: readonly string[]): void {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(QUEUE_BOARD_PATH);
  createBullBoard({
    queues: queueNames.map(
      (name) => new BullMQAdapter(app.get<Queue>(getQueueToken(name), { strict: false })),
    ),
    serverAdapter,
  });
  app.use(QUEUE_BOARD_PATH, serverAdapter.getRouter());
}
