import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { ClsModule } from 'nestjs-cls';

import { AppExceptionFilter } from '@common/filters/app-exception.filter';
import { AuthGuard } from '@common/guards/auth.guard';
import { httpEntry } from '@common/http/http-entry';
import { LocationInterceptor } from '@common/interceptors/location.interceptor';
import { ConfigModule } from '@config/config.module';
import { Clock, SystemClock } from '@shared/domain/clock';
import { LOGGER, type Logger } from '@shared/logger/logger';
import { METRICS, type Metrics } from '@shared/observability/metrics';

import { DatabaseModule } from './database/database.module';
import { createTransactionalAdapter } from './database/transactional.adapter';
import { EventsModule } from './events/events.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { InboxModule } from './inbox/inbox.module';
import { LoggerModule } from './logger/logger.module';
import { MessagingModule } from './messaging/messaging.module';
import { ObservabilityModule } from './observability/observability.module';
import { OutboxModule } from './outbox/outbox.module';
import { QueuesModule } from './queues/queues.module';
import { ReadRoutingModule } from './read-routing/read-routing.module';

/**
 * The frame every entrypoint imports: config, the logger, CLS + transactions, database,
 * events, queue and broker connections, the write side of the outbox, the inbox, the
 * idempotency keys, and the global HTTP pipeline (the entry of a request, filter, auth guard,
 * Location header, read routing). The HTTP pieces are inert in the worker, which serves no HTTP.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    LoggerModule,
    ObservabilityModule,
    ClsModule.forRootAsync({
      global: true,
      imports: [LoggerModule, ObservabilityModule],
      inject: [LOGGER, METRICS],
      // the scope of a request opens with its correlation id, and ends with its line in the
      // log and its observation in the metrics
      useFactory: (logger: Logger, metrics: Metrics) => ({
        middleware: { mount: true, setup: httpEntry(logger, metrics) },
      }),
      plugins: [
        new ClsPluginTransactional({
          imports: [DatabaseModule],
          adapter: createTransactionalAdapter(),
        }),
      ],
    }),
    EventsModule,
    QueuesModule,
    MessagingModule,
    OutboxModule,
    InboxModule,
    IdempotencyModule,
    ReadRoutingModule,
    JwtModule.register({}),
  ],
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: LocationInterceptor },
  ],
  exports: [Clock, JwtModule],
})
export class SharedModule {}
