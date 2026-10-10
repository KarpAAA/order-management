import { ValidationPipe, VersioningType } from '@nestjs/common';
import helmet from 'helmet';

import { CORRELATION_HEADER } from '@common/messaging/correlation-header';
import { setupSwagger } from '@common/swagger/setup-swagger';
import { validationExceptionFactory } from '@common/validation/validation-exception.factory';
import { appConfig, type AppConfig } from '@config/configuration';
import { setupQueueBoard } from '@infra/queues/queue-board';

import { ORDERS_QUEUE } from '@modules/orders';

import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

/**
 * The HTTP pipeline of the API process, in one place: main.api.ts calls it before listen(),
 * the API tests (test/helpers/api-app.ts) call it before init(). A test therefore exercises
 * exactly the production body limit, versioning and validation, never a copy of them.
 * The app must be created with `{ bodyParser: false }`.
 */
export function configureApi(app: NestExpressApplication): void {
  const config = app.get<AppConfig>(appConfig.KEY);

  app.use(helmet({ contentSecurityPolicy: false })); // JSON API; CSP would only break Swagger UI
  // a browser client may read the id its request was given (docs/adr/0023)
  app.enableCors({ origin: config.corsOrigins, exposedHeaders: [CORRELATION_HEADER] });
  // responses carry per-user data: no shared cache may keep them (http/api-conventions.md §6)
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
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
}
