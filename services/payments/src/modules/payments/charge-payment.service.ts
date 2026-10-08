import { Inject, Injectable, Logger } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';

import { PaymentStatus } from '@infra/database/generated/prisma/client';
import type { Payment } from '@infra/database/generated/prisma/client';
import { isUniqueViolation } from '@infra/database/prisma-errors';
import type { DbTransactionAdapter } from '@infra/database/transactional.adapter';
import type { Actor } from '@shared/auth/actor';
import { Clock } from '@shared/domain/clock';
import { newId } from '@shared/domain/id';
import type { Money } from '@shared/domain/money';
import { InfrastructureError } from '@shared/errors/infrastructure-error';

import { PaymentsPolicy } from './payments.policy';
import {
  PAYMENT_EVENTS_PUBLISHER,
  type PaymentEventsPublisher,
  type PaymentOutcome,
  type PaymentResult,
} from './ports/payment-events-publisher.port';
import { PAYMENT_GATEWAY, type PaymentGateway } from './ports/payment-gateway.port';

export const PSP_UNAVAILABLE = 'psp_unavailable';
export const PSP_REJECTED = 'psp_rejected';

export interface ChargePaymentCommand {
  workspaceId: string;
  orderId: string;
  paymentAttempt: number;
  amount: Money;
  idempotencyKey: string;
  correlationId: string;
  /** The broker delivers this command no more: a provider that is still down ends the attempt. */
  lastDelivery: boolean;
}

const SELECT = {
  id: true,
  workspaceId: true,
  orderId: true,
  attempt: true,
  amountMinor: true,
  currency: true,
  idempotencyKey: true,
  status: true,
  pspChargeId: true,
  failureCode: true,
  correlationId: true,
} as const;

type PaymentRow = Pick<Payment, keyof typeof SELECT>;

const resultOf = (row: PaymentRow): PaymentResult =>
  row.status === PaymentStatus.SUCCEEDED && row.pspChargeId !== null
    ? { status: 'succeeded', chargeId: row.pspChargeId }
    : { status: 'failed', failureCode: row.failureCode ?? PSP_REJECTED, chargeId: row.pspChargeId };

const outcomeOf = (row: PaymentRow, result: PaymentResult): PaymentOutcome => ({
  workspaceId: row.workspaceId,
  orderId: row.orderId,
  paymentAttempt: row.attempt,
  correlationId: row.correlationId,
  result,
});

/**
 * Charges one payment attempt of an order and tells how it ended.
 *
 * Three steps, and the provider is never called inside a transaction:
 *  1. the row of the attempt, PENDING;
 *  2. the call to the provider;
 *  3. one transaction: the row is settled and the answer is written to the outbox. The
 *     answer exists exactly when the row says how the attempt ended (docs/adr/0014).
 * A command is delivered at least once, so every step may run twice:
 *  - the row is unique per (order, attempt): the second delivery finds the first one's row;
 *  - the provider gets the same idempotency key and answers the same;
 *  - the row is settled only while PENDING; whoever comes second answers with what is stored.
 * A provider that does not answer leaves the row PENDING and the error to the consumer: the
 * command comes again after a delay, and its last delivery ends the attempt (docs/adr/0013).
 */
@Injectable()
export class ChargePaymentService {
  private readonly logger = new Logger(ChargePaymentService.name);

  constructor(
    private readonly txHost: TransactionHost<DbTransactionAdapter>,
    private readonly policy: PaymentsPolicy,
    private readonly clock: Clock,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(PAYMENT_EVENTS_PUBLISHER) private readonly publisher: PaymentEventsPublisher,
  ) {}

  async execute(cmd: ChargePaymentCommand, actor: Actor): Promise<void> {
    this.policy.assertCanCharge(actor);

    const payment = await this.open(cmd);
    if (payment.status !== PaymentStatus.PENDING) {
      // a repeated command is answered again: whoever sent it twice is still waiting
      await this.txHost.withTransaction(() => this.answer(payment));
      return;
    }

    const result = await this.charge(payment, cmd.lastDelivery);
    await this.settle(payment, result);
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
        select: SELECT,
      });
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) throw err;
      return this.txHost.tx.payment.findUniqueOrThrow({
        where: { orderId_attempt: attempt },
        select: SELECT,
      });
    }
  }

  /**
   * One call to the provider (ROADMAP 3.11 retries the call itself). A failure that may pass
   * is thrown while a delivery is left; on the last one it is the outcome, `psp_unavailable`:
   * `payment-failed` is final for the attempt, and the api waits for an answer.
   */
  private async charge(payment: PaymentRow, lastDelivery: boolean): Promise<PaymentResult> {
    try {
      const charge = await this.gateway.charge({
        amount: { amountMinor: payment.amountMinor, currency: payment.currency },
        reference: payment.orderId,
        idempotencyKey: payment.idempotencyKey,
      });
      // A decline is a business outcome, not an error.
      return charge.status === 'succeeded'
        ? { status: 'succeeded', chargeId: charge.chargeId }
        : { status: 'failed', failureCode: charge.declineCode, chargeId: charge.chargeId };
    } catch (err: unknown) {
      if (!(err instanceof InfrastructureError)) throw err;
      if (err.retryable && !lastDelivery) throw err;
      this.logger.warn(`charge of order ${payment.orderId} failed: ${err.message}`);
      return {
        status: 'failed',
        failureCode: err.retryable ? PSP_UNAVAILABLE : PSP_REJECTED,
        chargeId: null,
      };
    }
  }

  /**
   * PENDING → SUCCEEDED / FAILED, once, and the answer with it, in one transaction. A
   * concurrent delivery that settled the row first wins: this one waits for its commit,
   * changes nothing, and answers with what that delivery stored.
   */
  private settle(payment: PaymentRow, result: PaymentResult): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const { tx } = this.txHost;
      await tx.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.PENDING },
        data: {
          status: result.status === 'succeeded' ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED,
          pspChargeId: result.chargeId,
          failureCode: result.status === 'failed' ? result.failureCode : null,
          settledAt: this.clock.now(),
        },
      });
      await this.answer(
        await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: SELECT }),
      );
    });
  }

  /** The outcome of a settled row, into the outbox of the transaction that is open. */
  private answer(settled: PaymentRow): Promise<void> {
    return this.publisher.publish(outcomeOf(settled, resultOf(settled)));
  }
}
