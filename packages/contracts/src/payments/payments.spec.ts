import { describe, expect, it } from 'vitest';

import { ChargePaymentV1 } from './charge-payment.v1';
import { PaymentFailedV1 } from './payment-failed.v1';
import { PaymentSucceededV1 } from './payment-succeeded.v1';

import type { MessageMeta } from '../envelope';

const META: MessageMeta = {
  messageId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e01',
  occurredAt: new Date('2026-10-06T10:15:30.123Z'),
  workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
  correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
};
const ORDER_ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04';

const charge = ChargePaymentV1.create(META, {
  orderId: ORDER_ID,
  paymentAttempt: 1,
  amount: { amountMinor: 12_990, currency: 'EUR' },
  idempotencyKey: `${ORDER_ID}:1`,
});
const succeeded = PaymentSucceededV1.create(META, {
  orderId: ORDER_ID,
  paymentAttempt: 1,
  chargeId: 'ch_1',
});
const failed = PaymentFailedV1.create(META, {
  orderId: ORDER_ID,
  paymentAttempt: 1,
  declineCode: 'insufficient_funds',
  chargeId: 'ch_1',
});

const CASES = [
  { contract: ChargePaymentV1, name: 'payments.charge-payment', message: charge },
  { contract: PaymentSucceededV1, name: 'payments.payment-succeeded', message: succeeded },
  { contract: PaymentFailedV1, name: 'payments.payment-failed', message: failed },
];

describe.each(CASES)('$name v1', ({ contract, name, message }) => {
  const withPayload = (change: Record<string, unknown>): unknown => ({
    ...message,
    payload: { ...message.payload, ...change },
  });

  it('keeps its name and version', () => {
    expect([contract.name, contract.version]).toEqual([name, 1]);
    expect([message.name, message.version]).toEqual([name, 1]);
  });

  it('survives JSON', () => {
    expect(contract.schema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it('reads a message that gained a field', () => {
    expect(contract.schema.parse(withPayload({ addedLater: true }))).toEqual(message);
  });

  it.each(Object.keys(message.payload))('requires payload.%s', (field) => {
    expect(contract.schema.safeParse(withPayload({ [field]: undefined })).success).toBe(false);
  });

  it.each([
    ['an order id that is not a uuid', { orderId: 'order-1' }],
    ['attempt 0', { paymentAttempt: 0 }],
    ['a fractional attempt', { paymentAttempt: 1.5 }],
    ['an attempt sent as a string', { paymentAttempt: '1' }],
  ])('rejects %s', (_case, change) => {
    expect(contract.schema.safeParse(withPayload(change)).success).toBe(false);
  });
});

describe('payments.charge-payment v1: amount', () => {
  const withAmount = (amount: unknown): unknown => ({
    ...charge,
    payload: { ...charge.payload, amount },
  });

  it('accepts zero', () => {
    expect(
      ChargePaymentV1.schema.safeParse(withAmount({ amountMinor: 0, currency: 'EUR' })).success,
    ).toBe(true);
  });

  it.each([
    ['a negative amount', { amountMinor: -1, currency: 'EUR' }],
    ['a fractional amount', { amountMinor: 129.9, currency: 'EUR' }],
    ['an amount past 2^53', { amountMinor: 2 ** 53, currency: 'EUR' }],
    ['an amount sent as a string', { amountMinor: '12990', currency: 'EUR' }],
    ['a lower-case currency', { amountMinor: 12_990, currency: 'eur' }],
    ['a currency that is not three letters', { amountMinor: 12_990, currency: 'EURO' }],
    ['no currency', { amountMinor: 12_990 }],
  ])('rejects %s', (_case, amount) => {
    expect(ChargePaymentV1.schema.safeParse(withAmount(amount)).success).toBe(false);
  });

  it('rejects an empty idempotency key', () => {
    const message = { ...charge, payload: { ...charge.payload, idempotencyKey: '' } };

    expect(ChargePaymentV1.schema.safeParse(message).success).toBe(false);
  });
});

describe('the charge id', () => {
  it('may be null on a failure: the provider never answered', () => {
    const message = PaymentFailedV1.create(META, {
      orderId: ORDER_ID,
      paymentAttempt: 5,
      declineCode: 'psp_unavailable',
      chargeId: null,
    });

    expect(message.payload.chargeId).toBeNull();
  });

  it('is never null on a success', () => {
    const message = { ...succeeded, payload: { ...succeeded.payload, chargeId: null } };

    expect(PaymentSucceededV1.schema.safeParse(message).success).toBe(false);
  });
});
