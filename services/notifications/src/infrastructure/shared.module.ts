import { Global, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { ClsModule } from 'nestjs-cls';

import { ConfigModule } from '@config/config.module';
import { Clock, SystemClock } from '@shared/domain/clock';

import { DatabaseModule } from './database/database.module';
import { createTransactionalAdapter } from './database/transactional.adapter';
import { InboxModule } from './inbox/inbox.module';
import { LoggerModule } from './logger/logger.module';
import { MessagingModule } from './messaging/messaging.module';
import { ObservabilityModule } from './observability/observability.module';

/**
 * The frame every entrypoint imports: config, the logger, database, CLS + transactions, broker
 * connection, the inbox, clock. No outbox: the service publishes nothing.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    ObservabilityModule,
    DatabaseModule,
    ClsModule.forRoot({
      global: true,
      plugins: [
        new ClsPluginTransactional({
          imports: [DatabaseModule],
          adapter: createTransactionalAdapter(),
        }),
      ],
    }),
    MessagingModule,
    InboxModule,
  ],
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class SharedModule {}
