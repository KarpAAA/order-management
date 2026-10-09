import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module';

/**
 * A broker consumer and the dispatcher of the notifications. No HTTP server: health and metrics endpoints arrive in Steps 4–5,
 * and then the process gets a probe-only port (ops/process-model.md §3).
 */
async function bootstrap(): Promise<void> {
  await NestFactory.createApplicationContext(WorkerModule);
  new Logger('Notifications').log('notifications worker started');
}

void bootstrap();
