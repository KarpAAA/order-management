import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { NestLoggerAdapter } from '@infra/logger/nest-logger.adapter';
import { LOGGER, type Logger } from '@shared/logger/logger';

import { WorkerModule } from './worker.module';

/**
 * A broker consumer and the dispatcher of the notifications. No HTTP server: health and metrics endpoints arrive in Steps 4–5,
 * and then the process gets a probe-only port (ops/process-model.md §3).
 */
async function bootstrap(): Promise<void> {
  // held until the logger of the process exists: what Nest says at boot is JSON too
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(NestLoggerAdapter));
  app.get<Logger>(LOGGER).info({ context: 'Notifications' }, 'notifications worker started');
}

void bootstrap();
