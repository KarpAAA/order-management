import { Inject } from '@nestjs/common';

import { UseCase } from '@common/decorators/use-case.decorator';
import type { Actor } from '@shared/auth/actor';
import { InfrastructureError } from '@shared/errors/infrastructure-error';

import { ORDERS_REPOSITORY, type OrdersRepositoryPort } from '../ports/orders-repository.port';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../ports/payment-gateway.port';

import { CompleteOrderPaymentService } from './complete-order-payment.service';
import { FailOrderPaymentService } from './fail-order-payment.service';
import { OrdersPolicy } from './orders.policy';

import type { ProcessOrderPaymentCommand } from './order-commands';

export const PSP_UNAVAILABLE = 'psp_unavailable';
export const PSP_REJECTED = 'psp_rejected';

/**
 * Charges one payment attempt. Deliberately NOT transactional: the gateway call must never
 * run inside an open transaction. The outcome is recorded by a second, transactional use
 * case (`CompleteOrderPayment` / `FailOrderPayment`).
 *
 * Idempotent: a stale or duplicate job fails `assertAwaitingPayment` (InvalidStateError,
 * treated as "already done" by the consumer), and the PSP idempotency key
 * `<orderId>:<attempt>` makes a re-run of the same attempt return the same charge.
 */
@UseCase()
export class ProcessOrderPaymentService {
  constructor(
    @Inject(ORDERS_REPOSITORY) private readonly orders: OrdersRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly policy: OrdersPolicy,
    private readonly completePayment: CompleteOrderPaymentService,
    private readonly failPayment: FailOrderPaymentService,
  ) {}

  async execute(cmd: ProcessOrderPaymentCommand, actor: Actor): Promise<void> {
    const order = await this.orders.getById(cmd.orderId);
    this.policy.assertCanSettlePayment(actor);
    order.assertAwaitingPayment(cmd.paymentAttempt);

    const outcome = { orderId: cmd.orderId, paymentAttempt: cmd.paymentAttempt };
    let result;
    try {
      result = await this.gateway.charge({
        amount: order.amountDue,
        reference: order.id,
        idempotencyKey: `${order.id}:${cmd.paymentAttempt}`,
      });
    } catch (err: unknown) {
      // Transient failures are retried by the queue until its last attempt.
      if (!(err instanceof InfrastructureError) || (err.retryable && !cmd.isFinalAttempt)) {
        throw err;
      }
      const reason = err.retryable ? PSP_UNAVAILABLE : PSP_REJECTED;
      await this.failPayment.execute({ ...outcome, reason }, actor);
      return;
    }

    // A decline is a business outcome, not an error: no retry.
    if (result.status === 'succeeded') {
      await this.completePayment.execute({ ...outcome, pspChargeId: result.chargeId }, actor);
    } else {
      await this.failPayment.execute({ ...outcome, reason: result.declineCode }, actor);
    }
  }
}
