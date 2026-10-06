import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { ClsModule } from 'nestjs-cls';

import { AppExceptionFilter } from '@common/filters/app-exception.filter';
import { AuthGuard } from '@common/guards/auth.guard';
import { LocationInterceptor } from '@common/interceptors/location.interceptor';
import { ConfigModule } from '@config/config.module';
import { Clock, SystemClock } from '@shared/domain/clock';

import { DatabaseModule } from './database/database.module';
import { createTransactionalAdapter } from './database/transactional.adapter';
import { EventsModule } from './events/events.module';
import { MessagingModule } from './messaging/messaging.module';
import { QueuesModule } from './queues/queues.module';
import { ReadRoutingModule } from './read-routing/read-routing.module';

/**
 * The frame every entrypoint imports: config, CLS + transactions, database, events, queue
 * and broker connections, and the global HTTP pipeline (filter, auth guard, Location header, read routing).
 * The HTTP pieces are inert in the worker, which serves no HTTP.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true },
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
