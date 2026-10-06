import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '@config/config.module';
import { Clock, SystemClock } from '@shared/domain/clock';

import { DatabaseModule } from './database/database.module';
import { MessagingModule } from './messaging/messaging.module';

/** The frame every entrypoint imports: config, database, broker connection, clock. */
@Global()
@Module({
  imports: [ConfigModule, DatabaseModule, MessagingModule],
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class SharedModule {}
