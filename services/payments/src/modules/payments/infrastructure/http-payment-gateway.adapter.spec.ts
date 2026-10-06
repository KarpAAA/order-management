import { Logger } from '@nestjs/common';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { GatewayConfig } from '@config/configuration';

import { FakePaymentGateway } from './fake-payment-gateway.adapter';
import { HttpPaymentGateway } from './http-payment-gateway.adapter';
import { PaymentGatewayError } from './payment-gateway.error';

import type { ChargeRequest, PaymentGateway } from '../ports/payment-gateway.port';

// Small timeout so a timeout test waits milliseconds, not the production 3 s.
const TIMEOUT_MS = 100;
const config: GatewayConfig = {
  gateway: 'http',
  pspBaseUrl: 'http://psp.test',
  pspTimeoutMs: TIMEOUT_MS,
};
const CHARGES_URL = 'http://psp.test/charges';

const request = (overrides: Partial<ChargeRequest> = {}): ChargeRequest => ({
  amount: { amountMinor: 12_50n, currency: 'EUR' },
  reference: 'order-1',
  idempotencyKey: 'order-1:1',
  ...overrides,
});

// Inline stand-in for devtools/fake-psp: idempotent by key, same public shape. It declines
// amounts ending in 13 minor units, like FakePaymentGateway, so one contract drives both.
const chargesByKey = new Map<string, { id: string; status: string; declineCode?: string }>();
const fakePsp = http.post(CHARGES_URL, async ({ request: req }) => {
  const key = req.headers.get('idempotency-key') ?? '';
  const { amountMinor } = (await req.json()) as { amountMinor: number };
  const charge = chargesByKey.get(key) ?? {
    id: `ch_${String(chargesByKey.size + 1)}`,
    ...(amountMinor % 100 === 13
      ? { status: 'declined', declineCode: 'card_declined' }
      : { status: 'succeeded' }),
  };
  chargesByKey.set(key, charge);
  return HttpResponse.json(charge, { status: 201 });
});

const server = setupServer(fakePsp);

beforeAll(() => {
  Logger.overrideLogger(false);
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  chargesByKey.clear();
});
afterAll(() => {
  server.close();
});

/** The gateway error the charge rejected with; fails the test if it resolved. */
async function gatewayError(gateway: PaymentGateway): Promise<PaymentGatewayError> {
  const err: unknown = await gateway.charge(request()).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PaymentGatewayError);
  return err as PaymentGatewayError;
}

describe.each([
  { name: 'HttpPaymentGateway', create: (): PaymentGateway => new HttpPaymentGateway(config) },
  { name: 'FakePaymentGateway', create: (): PaymentGateway => new FakePaymentGateway() },
])('$name — PaymentGateway contract', ({ create }) => {
  it('returns succeeded with a charge id', async () => {
    const result = await create().charge(request());

    expect(result).toEqual({ status: 'succeeded', chargeId: expect.any(String) });
  });

  it('returns a decline as a result, not an error', async () => {
    const result = await create().charge(
      request({ amount: { amountMinor: 10_13n, currency: 'EUR' } }),
    );

    expect(result).toEqual({
      status: 'declined',
      chargeId: expect.any(String),
      declineCode: 'card_declined',
    });
  });

  it('returns the same result for the same idempotency key', async () => {
    const gateway = create();

    const first = await gateway.charge(request());
    const second = await gateway.charge(request());

    expect(second).toEqual(first);
  });

  it('creates a new charge for a new idempotency key', async () => {
    const gateway = create();

    const first = await gateway.charge(request({ idempotencyKey: 'order-1:1' }));
    const second = await gateway.charge(request({ idempotencyKey: 'order-1:2' }));

    expect(second.chargeId).not.toBe(first.chargeId);
  });
});

describe('HttpPaymentGateway', () => {
  const gateway = new HttpPaymentGateway(config);
  const respondWith = (resolver: Parameters<typeof http.post>[1]): void => {
    server.use(http.post(CHARGES_URL, resolver));
  };

  it('posts the amount, currency and reference with the idempotency key (PAY-003)', async () => {
    let sent: { headers: Headers; body: unknown } | undefined;
    respondWith(async ({ request: req }) => {
      sent = { headers: req.headers, body: await req.json() };
      return HttpResponse.json({ id: 'ch_1', status: 'succeeded' }, { status: 201 });
    });

    await gateway.charge(
      request({
        amount: { amountMinor: 99_90n, currency: 'USD' },
        reference: 'order-7',
        idempotencyKey: 'order-7:2',
      }),
    );

    expect(sent?.headers.get('idempotency-key')).toBe('order-7:2');
    expect(sent?.headers.get('content-type')).toBe('application/json');
    expect(sent?.body).toEqual({ amountMinor: 9990, currency: 'USD', reference: 'order-7' });
  });

  it('defaults the decline code when the PSP sends none', async () => {
    respondWith(() => HttpResponse.json({ id: 'ch_1', status: 'declined' }, { status: 201 }));

    await expect(gateway.charge(request())).resolves.toEqual({
      status: 'declined',
      chargeId: 'ch_1',
      declineCode: 'declined',
    });
  });

  it.each([500, 502, 503, 429])('treats HTTP %i as transient', async (status) => {
    respondWith(() => HttpResponse.json({ error: 'nope' }, { status }));

    expect((await gatewayError(gateway)).retryable).toBe(true);
  });

  it.each([400, 401, 404, 422])('treats HTTP %i as rejected (no retry)', async (status) => {
    respondWith(() => HttpResponse.json({ error: 'nope' }, { status }));

    expect((await gatewayError(gateway)).retryable).toBe(false);
  });

  it.each([
    ['an unknown shape', { foo: 1 }],
    ['an unknown status', { id: 'ch_1', status: 'weird' }],
    ['no id', { status: 'succeeded' }],
  ])('treats a body with %s as rejected', async (_, body) => {
    respondWith(() => HttpResponse.json(body, { status: 201 }));

    expect((await gatewayError(gateway)).retryable).toBe(false);
  });

  it('treats malformed JSON as rejected (PAY-008)', async () => {
    respondWith(
      () =>
        new HttpResponse('{"id": "ch_1", "status": ', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );

    expect((await gatewayError(gateway)).retryable).toBe(false);
  });

  it('treats a network failure as transient', async () => {
    respondWith(() => HttpResponse.error());

    expect((await gatewayError(gateway)).retryable).toBe(true);
  });

  it('treats a response slower than the timeout as transient (PAY-006)', async () => {
    respondWith(async () => {
      await delay(TIMEOUT_MS * 3);
      return HttpResponse.json({ id: 'ch_1', status: 'succeeded' }, { status: 201 });
    });

    expect((await gatewayError(gateway)).retryable).toBe(true);
  });

  it('accepts a slow response that is still within the timeout', async () => {
    respondWith(async () => {
      await delay(TIMEOUT_MS / 4);
      return HttpResponse.json({ id: 'ch_1', status: 'succeeded' }, { status: 201 });
    });

    await expect(gateway.charge(request())).resolves.toEqual({
      status: 'succeeded',
      chargeId: 'ch_1',
    });
  });

  // Not covered: a body cut off by the timeout after the headers arrived. MSW does not
  // propagate the abort signal into a mocked body stream, so the read just completes.
});
