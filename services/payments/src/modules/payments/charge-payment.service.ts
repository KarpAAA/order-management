import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import { PaymentStatus } from '@infra/database/generated/prisma/client';
import { isUniqueViolation } from '@infra/database/prisma-errors';
import type { DbTransactionAdapter } from '@infra/database/transactional.adapter';
import { Inbox } from '@infra/inbox/inbox';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';
import type { Money } from '@shared/domain/money';
import { InfrastructureError } from '@shared/errors/infrastructure-error';

import {
  EXPIRED,
  outcomeOf,
  PAYMENT_SELECT,
  PSP_REJECTED,
  PSP_UNAVAILABLE,
  type PaymentRow,
} from './payment-row';
import { PaymentsPolicy } from './payments.policy';
import {
  PAYMENT_EVENTS_PUBLISHER,
  type PaymentEventsPublisher,
  type PaymentResult,
} from './ports/payment-events-publisher.port';
import {
  PAYMENT_GATEWAY,
  type ChargeRequest,
  type PaymentGateway,
} from './ports/payment-gateway.port';

export interface ChargePaymentCommand {
  /** The message that carries the command and the queue it was read from: the inbox's key. */
  messageId: string;
  queue: string;
  workspaceId: string;
  orderId: string;
  paymentAttempt: number;
  amount: Money;
  idempotencyKey: string;
  correlationId: string;
  /** Until when the sender waits for the charge; null: the command never expires. */
  expiresAt: Date | null;
  /** The broker delivers this command no more: a provider that is still down ends the attempt. */
  lastDelivery: boolean;
}

/** How a call to the provider ends; "cancelled" is never its answer. */
type ChargeOutcome = Exclude<PaymentResult, { status: 'cancelled' }>;

/** What the provider is asked for. Only a row that never saw its charge command has none. */
const chargeOf = (payment: PaymentRow): ChargeRequest => {
  const { amountMinor, currency, idempotencyKey } = payment;
  if (amountMinor === null || currency === null || idempotencyKey === null) {
    throw new Error(`payment ${payment.id} is ${payment.status} without a charge to make`);
  }
  return { amount: { amountMinor, currency }, reference: payment.orderId, idempotencyKey };
};

/**
 * Charges one payment attempt of an order and tells how it ended.
 *
 * Three steps, and the provider is never called inside a transaction:
 *  1. the row of the attempt, PENDING;
 *  2. the call to the provider;
 *  3. one transaction: the message is recorded in the inbox, the row is settled and the
 *     answer is written to the outbox. The answer exists exactly when the row says how the
 *     attempt ended (docs/adr/0014), and the message is handled exactly when both are there
 *     (docs/adr/0015).
 * A command is delivered at least once, so every step may run twice:
 *  - the row is unique per (order, attempt): the second delivery finds the first one's row;
 *  - the provider gets the same idempotency key and answers the same;
 *  - the same message again finds itself in the inbox: nothing is settled, nothing answered;
 *  - another message for the same attempt finds the row settled and is answered with what
 *    is stored: the row is settled only while PENDING.
 * A provider that does not answer leaves the row PENDING and the error to the consumer: the
 * command comes again after a delay, and its last delivery ends the attempt (docs/adr/0013).
 *
 * The attempt may be cancelled meanwhile (cancel-payment.service.ts, docs/adr/0017):
 *  - before the command arrived: the row is there, CANCELLED, and nothing is charged;
 *  - during the call to the provider: the row is no longer PENDING when the call returns. A
 *    charge that was made is kept on the row and taken back, and the answer is "cancelled".
 * A command handled after its `expiresAt` charges nothing: its sender stopped waiting.
 */
@Injectable()
export class ChargePaymentService {
  private readonly logger = new Logger(ChargePaymentService.name);

  constructor(
    private readonly txHost: TransactionHost<DbTransactionAdapter>,
    private readonly inbox: Inbox,
    private readonly policy: PaymentsPolicy,
    private readonly clock: Clock,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(PAYMENT_EVENTS_PUBLISHER) private readonly publisher: PaymentEventsPublisher,
  ) {}

  async execute(cmd: ChargePaymentCommand, actor: Actor): Promise<void> {
    this.policy.assertCanCharge(actor);

    const payment = await this.open(cmd);
    if (payment.status !== PaymentStatus.PENDING) {
      // an earlier delivery died between the cancelled row and the provider
      await this.voidIfCharged(payment);
      // The same message again: answered when it was handled. Another message for a settled
      // attempt is answered again: whoever sent it is still waiting.
      await this.txHost.withTransaction(async () => {
        if (await this.inbox.record(cmd.queue, cmd.messageId)) await this.answer(payment);
      });
      return;
    }

    const result = await this.charge(payment, cmd);
    const settled = await this.settle(cmd, payment, result);
    if (settled) await this.voidIfCharged(settled);
  }

  /** The row of this attempt: created PENDING, or the one an earlier delivery created. */
  private async open(cmd: ChargePaymentCommand): Promise<PaymentRow> {
    const attempt = { orderId: cmd.orderId, attempt: cmd.paymentAttempt };
    try {
      return await this.txHost.tx.payment.create({
        data: {
          id: newId(),
          workspaceId: cmd.workspaceId,
          ...attempt,
          amountMinor: cmd.amount.amountMinor,
          currency: cmd.amount.currency,
          idempotencyKey: cmd.idempotencyKey,
          correlationId: cmd.correlationId,
          createdAt: this.clock.now(),
        },
        select: PAYMENT_SELECT,
      });
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) throw err;
      return this.txHost.tx.payment.findUniqueOrThrow({
        where: { orderId_attempt: attempt },
        select: PAYMENT_SELECT,
      });
    }
  }

  /**
   * One call to the provider (ROADMAP 3.11 retries the call itself). A failure that may pass
   * is thrown while a delivery is left; on the last one it is the outcome, `psp_unavailable`:
   * `payment-failed` is final for the attempt, and the api waits for an answer.
   */
  private async charge(payment: PaymentRow, cmd: ChargePaymentCommand): Promise<ChargeOutcome> {
    if (cmd.expiresAt !== null && this.clock.now() >= cmd.expiresAt) {
      // checked on every delivery: a provider that is down past the deadline ends here too
      this.logger.warn(`charge of order ${payment.orderId} expired before it was made`);
      return { status: 'failed', failureCode: EXPIRED, chargeId: null };
    }
    try {
      const charge = await this.gateway.charge(chargeOf(payment));
      // A decline is a business outcome, not an error.
      return charge.status === 'succeeded'
        ? { status: 'succeeded', chargeId: charge.chargeId }
        : { status: 'failed', failureCode: charge.declineCode, chargeId: charge.chargeId };
    } catch (err: unknown) {
      if (!(err instanceof InfrastructureError)) throw err;
      if (err.retryable && !cmd.lastDelivery) throw err;
      this.logger.warn(`charge of order ${payment.orderId} failed: ${err.message}`);
      return {
        status: 'failed',
        failureCode: err.retryable ? PSP_UNAVAILABLE : PSP_REJECTED,
        chargeId: null,
      };
    }
  }

  /**
   * PENDING → SUCCEEDED / FAILED, once, with the record of the message and the answer, in
   * one transaction. The record comes first: a concurrent delivery of the same message makes
   * this one wait there, and once that one has committed there is nothing left to do. A
   * concurrent delivery of another message that settled the row first wins as well: this one
   * changes nothing and answers with what that delivery stored. So does a cancellation: the
   * charge the provider made meanwhile is written on the cancelled row, for the caller to
   * take back. Returns the row as it is now, or null for a message that was recorded before.
   */
  private settle(
    cmd: ChargePaymentCommand,
    payment: PaymentRow,
    result: ChargeOutcome,
  ): Promise<PaymentRow | null> {
    return this.txHost.withTransaction(async () => {
      if (!(await this.inbox.record(cmd.queue, cmd.messageId))) return null;
      const { tx } = this.txHost;
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: result.status === 'succeeded' ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED,
          pspChargeId: result.chargeId,
          failureCode: result.status === 'failed' ? result.failureCode : null,
          settledAt: this.clock.now(),
        },
      });
      if (count === 0 && result.status === 'succeeded') {
        await tx.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.CANCELLED, pspChargeId: null },
          data: { pspChargeId: result.chargeId },
        });
      }
      const settled = await tx.payment.findUniqueOrThrow({
        where: { id: payment.id },
        select: PAYMENT_SELECT,
      });
      await this.answer(settled);
      return settled;
    });
  }

  /**
   * A cancelled attempt the provider charged all the same: the charge is taken back, and the
   * row says so. Outside any transaction, like the charge. A failure is thrown: the command
   * comes again, finds the row with its charge and no `voided_at`, and ends up here.
   */
  private async voidIfCharged(payment: PaymentRow): Promise<void> {
    if (payment.status !== PaymentStatus.CANCELLED) return;
    if (payment.pspChargeId === null || payment.voidedAt !== null) return;
    await this.gateway.void(payment.pspChargeId);
    await this.txHost.tx.payment.updateMany({
      where: { id: payment.id, voidedAt: null },
      data: { voidedAt: this.clock.now() },
    });
    this.logger.warn(`charge ${payment.pspChargeId} of cancelled order ${payment.orderId} voided`);
  }

  /** The outcome of a settled row, into the outbox of the transaction that is open. */
  private answer(settled: PaymentRow): Promise<void> {
    return this.publisher.publish(outcomeOf(settled));
  }
}
