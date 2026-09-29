import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { appConfig, type AppConfig } from '@config/configuration';

import { ApiModule } from './api.module';
import { configureApi } from './configure-api';

import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { bodyParser: false });
  configureApi(app);
  await app.listen(app.get<AppConfig>(appConfig.KEY).port);
}

void bootstrap();
