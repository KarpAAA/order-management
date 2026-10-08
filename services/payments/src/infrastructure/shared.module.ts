import { Global, Module } from '@nestjs/common';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { ClsModule } from 'nestjs-cls';

import { ConfigModule } from '@config/config.module';
import { Clock, SystemClock } from '@shared/domain/clock';

import { DatabaseModule } from './database/database.module';
import { createTransactionalAdapter } from './database/transactional.adapter';
import { MessagingModule } from './messaging/messaging.module';
import { OutboxModule } from './outbox/outbox.module';

/**
 * The frame every entrypoint imports: config, database, CLS + transactions, broker
 * connection, the write side of the outbox, clock.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
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
    OutboxModule,
  ],
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class SharedModule {}
