// layered · L4 · together
import { Module } from '@nestjs/common';

import { notificationsConfig, type NotificationsConfig } from '@config/configuration';

import { DispatchNotificationService } from './application/dispatch-notification.service';
import { DELIVERY_POLICY, type DeliveryPolicy } from './application/notification-commands';
import { NotificationsPolicy } from './application/notifications.policy';
import { RequestNotificationService } from './application/request-notification.service';
import { NotificationsCleanup } from './infrastructure/notifications-cleanup';
import { NotificationsRepository } from './infrastructure/notifications.repository';
import { SmtpMailerAdapter } from './infrastructure/smtp-mailer.adapter';
import { MAILER } from './ports/mailer.port';
import { NOTIFICATIONS_REPOSITORY } from './ports/notifications-repository.port';

const USE_CASES = [RequestNotificationService, DispatchNotificationService];

@Module({
  providers: [
    // write
    ...USE_CASES,
    NotificationsPolicy,
    { provide: NOTIFICATIONS_REPOSITORY, useClass: NotificationsRepository },
    // the outside this module writes to: a mail server over SMTP
    { provide: MAILER, useClass: SmtpMailerAdapter },
    {
      provide: DELIVERY_POLICY,
      inject: [notificationsConfig.KEY],
      useFactory: (config: NotificationsConfig): DeliveryPolicy => ({
        maxSendAttempts: config.maxSendAttempts,
        retryDelayMs: config.sendRetryDelayMs,
      }),
    },
    // retention
    NotificationsCleanup,
  ],
  // No facade: no other module exists. The use cases and the cleanup are exported to the
  // module's own transport module only (Nest needs them exported to inject them into the
  // consumer and the runners).
  exports: [...USE_CASES, NotificationsCleanup],
})
export class NotificationsModule {}
