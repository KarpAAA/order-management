import { Inject, Injectable, Logger } from '@nestjs/common';

import { PaymentStatus } from '@infra/database/generated/prisma/client';
import type { Payment } from '@infra/database/generated/prisma/client';
import { isUniqueViolation } from '@infra/database/prisma-errors';
import { PrismaService } from '@infra/database/prisma.service';
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
 * No transaction: the provider is never called inside one, and each write is one statement.
 * A command is delivered at least once, so every step may run twice:
 *  - the row is unique per (order, attempt): the second delivery finds the first one's row;
 *  - the provider gets the same idempotency key and answers the same;
 *  - the row is settled only while PENDING; whoever comes second publishes what is stored.
 * The answer is published after the row is saved, not atomically with it (ROADMAP 3.4).
 */
@Injectable()
export class ChargePaymentService {
  private readonly logger = new Logger(ChargePaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PaymentsPolicy,
    private readonly clock: Clock,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(PAYMENT_EVENTS_PUBLISHER) private readonly publisher: PaymentEventsPublisher,
  ) {}

  async execute(cmd: ChargePaymentCommand, actor: Actor): Promise<void> {
    this.policy.assertCanCharge(actor);

    const payment = await this.open(cmd);
    if (payment.status !== PaymentStatus.PENDING) {
      // a repeated command: the first answer may have been lost, so it is given again
      await this.publisher.publish(outcomeOf(payment, resultOf(payment)));
      return;
    }

    const result = await this.charge(payment);
    const settled = await this.settle(payment, result);
    await this.publisher.publish(outcomeOf(settled, resultOf(settled)));
  }

  /** The row of this attempt: created PENDING, or the one an earlier delivery created. */
  private async open(cmd: ChargePaymentCommand): Promise<PaymentRow> {
    const attempt = { orderId: cmd.orderId, attempt: cmd.paymentAttempt };
    try {
      return await this.prisma.payment.create({
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
      return this.prisma.payment.findUniqueOrThrow({
        where: { orderId_attempt: attempt },
        select: SELECT,
      });
    }
  }

  /**
   * One call to the provider. A failure of the call ends the attempt at once: there is no
   * retry yet (ROADMAP 3.3 redelivers the command with a delay, 3.11 retries the call).
   */
  private async charge(payment: PaymentRow): Promise<PaymentResult> {
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
      this.logger.warn(`charge of order ${payment.orderId} failed: ${err.message}`);
      return {
        status: 'failed',
        failureCode: err.retryable ? PSP_UNAVAILABLE : PSP_REJECTED,
        chargeId: null,
      };
    }
  }

  /** PENDING → SUCCEEDED / FAILED, once. Returns the row as stored, ours or a concurrent one. */
  private async settle(payment: PaymentRow, result: PaymentResult): Promise<PaymentRow> {
    await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.PENDING },
      data: {
        status: result.status === 'succeeded' ? PaymentStatus.SUCCEEDED : PaymentStatus.FAILED,
        pspChargeId: result.chargeId,
        failureCode: result.status === 'failed' ? result.failureCode : null,
        settledAt: this.clock.now(),
      },
    });
    return this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id }, select: SELECT });
  }
}
