import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { OutboxModule } from '@infra/outbox/outbox.module';
import { EVENT_PUBLISHER } from '@shared/events/event-publisher';

import { DomainEventPublisher } from './domain-event.publisher';
import { EventMeters } from './event-meters';

@Global()
@Module({
  // the outbox: where a reliable event goes
  imports: [CqrsModule.forRoot(), OutboxModule],
  providers: [{ provide: EVENT_PUBLISHER, useClass: DomainEventPublisher }, EventMeters],
  exports: [EVENT_PUBLISHER, EventMeters],
})
export class EventsModule {}
