import { AdjustStockV1 } from '../inventory/adjust-stock.v1';
import { ReleaseStockV1 } from '../inventory/release-stock.v1';
import { ReserveStockV1 } from '../inventory/reserve-stock.v1';
import { StockAdjustedV1 } from '../inventory/stock-adjusted.v1';
import { StockReleasedV1 } from '../inventory/stock-released.v1';
import { StockReservationFailedV1 } from '../inventory/stock-reservation-failed.v1';
import { StockReservedV1 } from '../inventory/stock-reserved.v1';
import { OrderCancelledV1 } from '../orders/order-cancelled.v1';
import { OrderFulfilledV1 } from '../orders/order-fulfilled.v1';
import { OrderPaidV1 } from '../orders/order-paid.v1';
import { OrderPaymentFailedV1 } from '../orders/order-payment-failed.v1';
import { OrderPlacedV1 } from '../orders/order-placed.v1';
import { OrderReturnedToDraftV1 } from '../orders/order-returned-to-draft.v1';
import { CancelPaymentV1 } from '../payments/cancel-payment.v1';
import { ChargePaymentV1 } from '../payments/charge-payment.v1';
import { PaymentCancelledV1 } from '../payments/payment-cancelled.v1';
import { PaymentFailedV1 } from '../payments/payment-failed.v1';
import { PaymentSucceededV1 } from '../payments/payment-succeeded.v1';
import { contractKey } from '../registry';

import type { MessageMeta } from '../envelope';
import type { AnyMessage, Contract } from '../registry';

const META: MessageMeta = {
  messageId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e01',
  occurredAt: new Date('2026-10-09T10:15:30.123Z'),
  workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
  correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
};
const ORDER_ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04';
const PRODUCT_ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e05';
const AMOUNT = { amountMinor: 12_990, currency: 'EUR' };
const RECIPIENT = { userId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e06', email: 'buyer@example.test' };
const PAYMENT = { orderId: ORDER_ID, paymentAttempt: 1 };
const RESERVATION = { orderId: ORDER_ID, attempt: 1 };

/**
 * One message of every contract, as its sender would write it: what `contracts:freeze` keeps
 * as the sample of a version on the day it is released. A new contract needs its line here;
 * the sample of a released version is never written again.
 */
const examples: readonly AnyMessage[] = [
  ChargePaymentV1.create(META, {
    ...PAYMENT,
    amount: AMOUNT,
    idempotencyKey: `${ORDER_ID}:1`,
    expiresAt: '2026-10-09T10:25:30.123Z',
  }),
  CancelPaymentV1.create(META, PAYMENT),
  PaymentSucceededV1.create(META, { ...PAYMENT, chargeId: 'ch_1' }),
  PaymentFailedV1.create(META, { ...PAYMENT, declineCode: 'insufficient_funds', chargeId: 'ch_1' }),
  PaymentCancelledV1.create(META, PAYMENT),

  ReserveStockV1.create(META, { ...RESERVATION, lines: [{ productId: PRODUCT_ID, quantity: 2 }] }),
  ReleaseStockV1.create(META, RESERVATION),
  AdjustStockV1.create(META, { productId: PRODUCT_ID, delta: 50 }),
  StockReservedV1.create(META, RESERVATION),
  StockReservationFailedV1.create(META, {
    ...RESERVATION,
    reason: 'insufficient_stock',
    shortages: [{ productId: PRODUCT_ID, requested: 2, available: 0 }],
  }),
  StockReleasedV1.create(META, RESERVATION),
  StockAdjustedV1.create(META, { productId: PRODUCT_ID, onHand: 50, reserved: 0 }),

  OrderPlacedV1.create(META, { ...PAYMENT, amount: AMOUNT, recipient: RECIPIENT }),
  OrderPaidV1.create(META, { ...PAYMENT, chargeId: 'ch_1', amount: AMOUNT, recipient: RECIPIENT }),
  OrderCancelledV1.create(META, { orderId: ORDER_ID, recipient: RECIPIENT }),
  OrderFulfilledV1.create(META, { orderId: ORDER_ID, recipient: RECIPIENT }),
  OrderPaymentFailedV1.create(META, {
    ...PAYMENT,
    reason: 'card_declined',
    amount: AMOUNT,
    recipient: RECIPIENT,
  }),
  OrderReturnedToDraftV1.create(META, { ...PAYMENT, reason: 'out_of_stock', recipient: RECIPIENT }),
];

const byKey = new Map(
  examples.map((message) => [contractKey(message.name, message.version), message]),
);

/** The example of a contract, or nothing for a contract that was given none. */
export const exampleOf = (contract: Pick<Contract, 'name' | 'version'>): AnyMessage | undefined =>
  byKey.get(contractKey(contract.name, contract.version));
