import 'reflect-metadata';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';

import { setupSwagger } from '@common/swagger/setup-swagger';
import { validationExceptionFactory } from '@common/validation/validation-exception.factory';
import { appConfig, type AppConfig } from '@config/configuration';
import { setupQueueBoard } from '@infra/queues/queue-board';

import { ORDERS_QUEUE } from '@modules/orders';

import { ApiModule } from './api.module';

import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, { bodyParser: false });
  const config = app.get<AppConfig>(appConfig.KEY);

  app.use(helmet({ contentSecurityPolicy: false })); // JSON API; CSP would only break Swagger UI
  app.enableCors({ origin: config.corsOrigins });
  app.useBodyParser('json', { limit: '10kb' });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: validationExceptionFactory,
    }),
  );

  if (config.swaggerEnabled) setupSwagger(app);
  if (config.bullBoardEnabled) setupQueueBoard(app, [ORDERS_QUEUE]);

  await app.listen(config.port);
}

void bootstrap();
