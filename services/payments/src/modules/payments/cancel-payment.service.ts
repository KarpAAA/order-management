import { Inject, Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import { PaymentStatus } from '@infra/database/generated/prisma/client';
import type { DbTransactionAdapter } from '@infra/database/transactional.adapter';
import { Inbox } from '@infra/inbox/inbox';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';

import { outcomeOf, PAYMENT_SELECT } from './payment-row';
import { PaymentsPolicy } from './payments.policy';
import {
  PAYMENT_EVENTS_PUBLISHER,
  type PaymentEventsPublisher,
} from './ports/payment-events-publisher.port';

export interface CancelPaymentCommand {
  /** The message that carries the command and the queue it was read from: the inbox's key. */
  messageId: string;
  queue: string;
  workspaceId: string;
  orderId: string;
  paymentAttempt: number;
  correlationId: string;
}

/**
 * Ends a payment attempt that has not ended yet as CANCELLED, and tells how the attempt
 * ended (docs/adr/0017-order-saga.md). One transaction, no call to the provider:
 *  - the row is PENDING → CANCELLED. A call to the provider that is in flight finds the row
 *    settled when it returns, and takes its charge back (charge-payment.service.ts);
 *  - there is no row: the charge command has not arrived yet (it waits for a retry, or the
 *    service was away). A CANCELLED row is written, and the command finds it;
 *  - the row is SUCCEEDED or FAILED: nothing changes, and the answer is what is stored. The
 *    sender asked "do not charge", and learns that it was too late.
 * Repeatable like the charge: the same message again finds itself in the inbox, another
 * message for the attempt is answered from the row.
 */
@Injectable()
export class CancelPaymentService {
  constructor(
    private readonly txHost: TransactionHost<DbTransactionAdapter>,
    private readonly inbox: Inbox,
    private readonly policy: PaymentsPolicy,
    private readonly clock: Clock,
    @Inject(PAYMENT_EVENTS_PUBLISHER) private readonly publisher: PaymentEventsPublisher,
  ) {}

  async execute(cmd: CancelPaymentCommand, actor: Actor): Promise<void> {
    this.policy.assertCanCancel(actor);

    await this.txHost.withTransaction(async () => {
      if (!(await this.inbox.record(cmd.queue, cmd.messageId))) return;
      const { tx } = this.txHost;
      const attempt = { orderId: cmd.orderId, attempt: cmd.paymentAttempt };
      const now = this.clock.now();

      // No error when the charge command wrote its row first: this insert waits for that
      // transaction and inserts nothing, and the update below finds the row.
      await tx.payment.createMany({
        data: [
          {
            id: newId(),
            workspaceId: cmd.workspaceId,
            ...attempt,
            status: PaymentStatus.CANCELLED,
            correlationId: cmd.correlationId,
            createdAt: now,
            settledAt: now,
          },
        ],
        skipDuplicates: true,
      });
      await tx.payment.updateMany({
        where: { ...attempt, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.CANCELLED, settledAt: now },
      });

      const payment = await tx.payment.findUniqueOrThrow({
        where: { orderId_attempt: attempt },
        select: PAYMENT_SELECT,
      });
      await this.publisher.publish(outcomeOf(payment));
    });
  }
}
