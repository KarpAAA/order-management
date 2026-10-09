// The four ways an order ends, through the whole system: api → broker → inventory → broker →
// payments → provider → broker → api, and notifications → mail server beside it
// (docs/adr/0022-system-tests.md). Every service runs from its image; nothing stands in for
// one. A scenario looks through three windows only: the HTTP API, the provider and the
// mailbox of the user.
//
// One scenario per branch of the saga, to see each link carry a real message once. The rules
// of each service (a duplicate, a late answer, a timeout) are tested where a test can play
// the other side: in the e2e suite of that service.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ApiClient } from './helpers/api';
import { eventually } from './helpers/eventually';
import { untilMailed } from './helpers/mailbox';
import { psp } from './helpers/psp';
import { MEMBER_EMAIL, PRODUCTS } from './setup/stack';

const RECEIVED = 'We received your order';
const PAID = 'Your order is paid';
const PAYMENT_FAILED = 'The payment for your order did not go through';
const NOT_PLACED = 'Your order could not be placed';
const CANCELLED = 'Your order was cancelled';

/** How long the step took, for the reader of the run (docs/perf/3.13-system-tests.md). */
function stopwatch(): (step: string) => void {
  const started = Date.now();
  return (step) => {
    process.stdout.write(`[system] ${step}: ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  };
}

describe('an order through every service', () => {
  let member: ApiClient;

  beforeAll(async () => {
    member = await ApiClient.login(MEMBER_EMAIL);
  });

  afterEach(async () => {
    await psp.restore();
  });

  it('is paid: the stock is held, the provider charges the total, the user is told twice', async () => {
    const orderId = await member.createOrder([{ productId: PRODUCTS.stocked, quantity: 2 }]);
    const lap = stopwatch();
    await member.place(orderId);

    const order = await member.untilSettled(orderId, 1);
    lap('place → PAID');
    expect(order.status).toBe('PAID');

    const charges = await psp.chargesOf(orderId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({
      id: order.pspChargeId,
      status: 'succeeded',
      idempotencyKey: `${orderId}:1`,
      amountMinor: order.totals.total.amountMinor,
      currency: order.totals.total.currency,
    });
    expect(charges[0]?.voidedAt).toBeUndefined();

    expect(await untilMailed(MEMBER_EMAIL, orderId, 2)).toEqual([RECEIVED, PAID].sort());
    lap('place → both mails');
  });

  it('is declined and placed again: the last unit comes back, and the second attempt gets it', async () => {
    const orderId = await member.createOrder([{ productId: PRODUCTS.lastUnit, quantity: 1 }]);

    await psp.configure({ declineRate: 1 });
    await member.place(orderId);
    const failed = await member.untilSettled(orderId, 1);
    expect(failed.status).toBe('PAYMENT_FAILED');
    expect(['insufficient_funds', 'card_declined', 'expired_card']).toContain(failed.failureReason);

    // the unit is held by the first attempt until inventory has given it back
    await member.untilRecorded(orderId, 'STOCK_RELEASED');

    await psp.configure({ declineRate: 0 });
    await member.place(orderId);
    const paid = await member.untilSettled(orderId, 2);
    expect(paid.status).toBe('PAID');

    const charges = await psp.chargesOf(orderId);
    expect(charges.map(({ idempotencyKey, status }) => ({ idempotencyKey, status }))).toEqual([
      { idempotencyKey: `${orderId}:1`, status: 'declined' },
      { idempotencyKey: `${orderId}:2`, status: 'succeeded' },
    ]);

    expect(await untilMailed(MEMBER_EMAIL, orderId, 4)).toEqual(
      [RECEIVED, PAYMENT_FAILED, RECEIVED, PAID].sort(),
    );
  });

  it('goes back to a draft when a product is out of stock: the provider is never asked', async () => {
    const orderId = await member.createOrder([
      { productId: PRODUCTS.stocked, quantity: 1 },
      { productId: PRODUCTS.unstocked, quantity: 1 },
    ]);
    await member.place(orderId);

    const order = await member.untilSettled(orderId, 1);
    expect(order.status).toBe('DRAFT');
    expect(order.failureReason).toBe('out_of_stock');

    expect(await untilMailed(MEMBER_EMAIL, orderId, 2)).toEqual([RECEIVED, NOT_PLACED].sort());
    // read after the mail: by then the saga had every chance to ask for a charge
    expect(await psp.chargesOf(orderId)).toEqual([]);
  });

  it('is cancelled while its charge is under way: the charge is taken back', async () => {
    const orderId = await member.createOrder([{ productId: PRODUCTS.alsoStocked, quantity: 1 }]);

    // long enough for the cancellation to cross the api and payments before the provider answers
    await psp.configure({ latencyMs: 5000 });
    await member.place(orderId);
    await eventually(
      () => psp.inFlight(),
      (calls) => calls === 1,
      {
        what: 'the charge to be with the provider',
      },
    );

    expect(await member.cancel(orderId)).toBe(202);
    // the charge that is under way keeps the delay it began with; the void after it is fast
    await psp.restore();

    const order = await member.untilSettled(orderId, 1);
    expect(order.status).toBe('CANCELLED');

    const [charge] = await eventually(
      () => psp.chargesOf(orderId),
      (charges) => charges[0]?.voidedAt !== undefined,
      { what: `the charge of order ${orderId} to be voided` },
    );
    expect(charge).toMatchObject({ status: 'succeeded', idempotencyKey: `${orderId}:1` });

    await member.untilRecorded(orderId, 'STOCK_RELEASED');
    expect(await untilMailed(MEMBER_EMAIL, orderId, 2)).toEqual([RECEIVED, CANCELLED].sort());
  });
});
