import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { OutboxModule } from '@infra/outbox/outbox.module';
import { EVENT_PUBLISHER } from '@shared/events/event-publisher';

import { DomainEventPublisher } from './domain-event.publisher';

@Global()
@Module({
  // the outbox: where a reliable event goes
  imports: [CqrsModule.forRoot(), OutboxModule],
  providers: [{ provide: EVENT_PUBLISHER, useClass: DomainEventPublisher }],
  exports: [EVENT_PUBLISHER],
})
export class EventsModule {}
