import { Global, Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { EVENT_PUBLISHER } from '@shared/events/event-publisher';

import { DomainEventPublisher } from './domain-event.publisher';

@Global()
@Module({
  imports: [CqrsModule.forRoot()],
  providers: [{ provide: EVENT_PUBLISHER, useClass: DomainEventPublisher }],
  exports: [EVENT_PUBLISHER],
})
export class EventsModule {}
