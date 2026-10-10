import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { appConfig, type AppConfig } from '@config/configuration';
import { NestLoggerAdapter } from '@infra/logger/nest-logger.adapter';

import { ApiModule } from './api.module';
import { configureApi } from './configure-api';

import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    bodyParser: false,
    // held until the logger of the process exists: what Nest says at boot is JSON too
    bufferLogs: true,
  });
  app.useLogger(app.get(NestLoggerAdapter));
  configureApi(app);
  await app.listen(app.get<AppConfig>(appConfig.KEY).port);
}

void bootstrap();
