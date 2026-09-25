import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from './worker.module';

/**
 * Queue consumers only. No HTTP server: health and metrics endpoints arrive in Steps 4–5,
 * and then the worker gets a probe-only port (ops/process-model.md §3).
 */
async function bootstrap(): Promise<void> {
  await NestFactory.createApplicationContext(WorkerModule);
  new Logger('Worker').log('worker started');
}

void bootstrap();
