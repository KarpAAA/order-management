import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GatewayConfig } from '@config/configuration';
import { silentLogger } from '@shared/logger/silent-logger';
import { RecordingMetrics } from '@shared/observability/__test__/recording-metrics';

import { FakePaymentGateway } from './fake-payment-gateway.adapter';
import { HttpPaymentGateway } from './http-payment-gateway.adapter';
import { PaymentGatewayError } from './payment-gateway.error';
import { CIRCUIT, parseRetryAfter } from './resilient-call';

import type { ChargeRequest, PaymentGateway } from '../ports/payment-gateway.port';

// Small timeout so a timeout test waits milliseconds, not the production 3 s.
const TIMEOUT_MS = 100;
// One call per operation and a breaker that never opens, unless a test asks: what a call
// makes of an answer is told apart from what is done about it. The pauses are milliseconds.
const config = (overrides: Partial<GatewayConfig> = {}): GatewayConfig => ({
  gateway: 'http',
  pspBaseUrl: 'http://psp.test',
  pspTimeoutMs: TIMEOUT_MS,
  pspCallBudgetMs: 5000,
  pspMaxRetries: 0,
  pspRetryInitialDelayMs: 5,
  pspRetryMaxDelayMs: 20,
  pspBreakerThreshold: 0.5,
  pspBreakerWindowMs: 10_000,
  pspBreakerMinCalls: 1000,
  pspBreakerHalfOpenMs: 100,
  ...overrides,
});
const CHARGES_URL = 'http://psp.test/charges';

/** The gateway as the service builds it, in the chain `correlationId` (none by default). */
const httpGateway = (gatewayConfig: GatewayConfig, correlationId?: string): HttpPaymentGateway =>
  new HttpPaymentGateway(gatewayConfig, silentLogger, { current: () => correlationId });

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

const voided = new Set<string>();
const fakeVoid = http.post(`${CHARGES_URL}/:id/void`, ({ params }) => {
  const known = [...chargesByKey.values()].some((charge) => charge.id === params.id);
  if (!known) return HttpResponse.json({ error: 'no such charge' }, { status: 404 });
  voided.add(String(params.id));
  return HttpResponse.json({ id: params.id, status: 'voided' });
});

const server = setupServer(fakePsp, fakeVoid);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
  chargesByKey.clear();
  voided.clear();
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
  { name: 'HttpPaymentGateway', create: (): PaymentGateway => httpGateway(config()) },
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

  it('takes a charge back, as often as it is asked to (PAY-023)', async () => {
    const gateway = create();
    const { chargeId } = await gateway.charge(request());

    await expect(gateway.void(chargeId)).resolves.toBeUndefined();
    await expect(gateway.void(chargeId)).resolves.toBeUndefined();
  });
});

describe('HttpPaymentGateway', () => {
  // one per test: the gateway remembers how its provider has been doing
  let gateway: HttpPaymentGateway;
  beforeEach(() => {
    gateway = httpGateway(config());
  });
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

  it('posts a void to the charge it names (PAY-023)', async () => {
    const { chargeId } = await gateway.charge(request());

    await gateway.void(chargeId);

    expect([...voided]).toEqual([chargeId]);
  });

  it('escapes the charge id in the path of a void', async () => {
    let path: string | undefined;
    server.use(
      http.post(`${CHARGES_URL}/:id/void`, ({ request: req }) => {
        path = new URL(req.url).pathname;
        return HttpResponse.json({ status: 'voided' });
      }),
    );

    await gateway.void('ch_order-1:1/x');

    expect(path).toBe('/charges/ch_order-1%3A1%2Fx/void');
  });

  it.each([
    [503, true],
    [429, true],
    [404, false],
  ])('treats HTTP %i on a void as retryable = %s', async (status, retryable) => {
    server.use(
      http.post(`${CHARGES_URL}/:id/void`, () => HttpResponse.json({ error: 'nope' }, { status })),
    );

    const err: unknown = await gateway.void('ch_1').then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(PaymentGatewayError);
    expect((err as PaymentGatewayError).retryable).toBe(retryable);
  });

  it('treats a void slower than the timeout as transient', async () => {
    server.use(
      http.post(`${CHARGES_URL}/:id/void`, async () => {
        await delay(TIMEOUT_MS * 3);
        return HttpResponse.json({ status: 'voided' });
      }),
    );

    await expect(gateway.void('ch_1')).rejects.toMatchObject({ retryable: true });
  });

  // Not covered: a body cut off by the timeout after the headers arrived. MSW does not
  // propagate the abort signal into a mocked body stream, so the read just completes.
});

type Answer = 'ok' | 'declined' | 'network' | 'slow' | 'malformed' | number | Response;

/**
 * The provider answers the next calls as scripted, then `ok`. A number is that status with
 * an error body. Returns what it was asked: the idempotency key of every call, in order.
 */
function script(url: string, ...answers: Answer[]): { calls: string[] } {
  const calls: string[] = [];
  server.use(
    http.post(url, async ({ request: req }) => {
      calls.push(req.headers.get('idempotency-key') ?? '');
      const answer = answers.shift() ?? 'ok';
      if (answer instanceof Response) return answer;
      if (answer === 'network') return HttpResponse.error();
      if (answer === 'malformed') return new HttpResponse('{"id": ', { status: 201 });
      if (answer === 'slow') await delay(TIMEOUT_MS * 3);
      if (typeof answer === 'number') {
        return HttpResponse.json({ error: 'nope' }, { status: answer });
      }
      return HttpResponse.json(
        answer === 'declined'
          ? { id: 'ch_1', status: 'declined', declineCode: 'card_declined' }
          : { id: 'ch_1', status: 'succeeded' },
        { status: 201 },
      );
    }),
  );
  return { calls };
}

const VOID_URL = `${CHARGES_URL}/:id/void`;
const throttled = (retryAfter: string): Response =>
  HttpResponse.json(
    { error: 'slow down' },
    { status: 429, headers: { 'retry-after': retryAfter } },
  );
const repeat = (answer: Answer, times: number): Answer[] =>
  Array.from({ length: times }, () => answer);

describe('HttpPaymentGateway: a call that may pass is made again (PAY-027)', () => {
  const retrying = (overrides: Partial<GatewayConfig> = {}): HttpPaymentGateway =>
    httpGateway(config({ pspMaxRetries: 2, ...overrides }));

  it.each<[string, Answer]>([
    ['a 503', 503],
    ['a 429', 429],
    ['a network failure', 'network'],
    ['a timeout', 'slow'],
  ])('charges after %s, with the same idempotency key', async (_, failure) => {
    const psp = script(CHARGES_URL, failure, failure);

    const result = await retrying().charge(request({ idempotencyKey: 'order-9:1' }));

    expect(result).toEqual({ status: 'succeeded', chargeId: 'ch_1' });
    expect(psp.calls).toEqual(['order-9:1', 'order-9:1', 'order-9:1']);
  });

  it('gives up after the retries it is allowed, with an error that may pass', async () => {
    const psp = script(CHARGES_URL, ...repeat(503, 10));

    const err = await gatewayError(retrying());

    expect(err).toMatchObject({ retryable: true, message: 'PSP responded 503' });
    expect(psp.calls).toHaveLength(3);
  });

  it('makes one call when no retry is allowed', async () => {
    const psp = script(CHARGES_URL, ...repeat(503, 10));

    await gatewayError(retrying({ pspMaxRetries: 0 }));

    expect(psp.calls).toHaveLength(1);
  });

  it.each<[string, Answer]>([
    ['a refusal (400)', 400],
    ['a malformed body', 'malformed'],
  ])('does not repeat %s (PAY-008)', async (_, answer) => {
    const psp = script(CHARGES_URL, answer);

    expect((await gatewayError(retrying())).retryable).toBe(false);
    expect(psp.calls).toHaveLength(1);
  });

  it('does not repeat a decline: it is an answer', async () => {
    const psp = script(CHARGES_URL, 'declined');

    await expect(retrying().charge(request())).resolves.toMatchObject({ status: 'declined' });
    expect(psp.calls).toHaveLength(1);
  });

  it('repeats a void as well', async () => {
    const psp = script(VOID_URL, 503);

    await expect(retrying().void('ch_1')).resolves.toBeUndefined();
    expect(psp.calls).toHaveLength(2);
  });
});

describe('HttpPaymentGateway: the pause a provider asks for (PAY-028)', () => {
  it('waits as long as Retry-After says before the next call', async () => {
    const psp = script(CHARGES_URL, throttled('1'));
    const gateway = httpGateway(config({ pspMaxRetries: 1, pspRetryMaxDelayMs: 1500 }));
    const startedAt = performance.now();

    await gateway.charge(request());

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(950);
    expect(psp.calls).toHaveLength(2);
  });

  it('does not sit out a pause longer than its own: the error says how long', async () => {
    const psp = script(CHARGES_URL, throttled('30'));
    const gateway = httpGateway(config({ pspMaxRetries: 2 }));

    const err = await gatewayError(gateway);

    expect(err).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
    expect(psp.calls).toHaveLength(1);
  });

  it.each([
    ['seconds', '2', 2000],
    ['seconds with spaces around', ' 10 ', 10_000],
    ['a date ahead', 'Fri, 09 Oct 2026 12:00:05 GMT', 5000],
    ['a date that has passed', 'Fri, 09 Oct 2026 11:59:00 GMT', 0],
    ['anything else', 'soon', undefined],
    ['a negative number', '-1', undefined],
  ])('reads Retry-After as %s', (_, header, expected) => {
    expect(parseRetryAfter(header, new Date('2026-10-09T12:00:00Z'))).toBe(expected);
  });

  it('reads no Retry-After as no answer', () => {
    expect(parseRetryAfter(null, new Date())).toBeUndefined();
  });
});

describe('HttpPaymentGateway: an operation has a time budget (PAY-029)', () => {
  it('stops a call that is under way when the budget ends', async () => {
    const psp = script(CHARGES_URL, ...repeat('slow', 10));
    const gateway = httpGateway(config({ pspMaxRetries: 5, pspCallBudgetMs: 150 }));
    const startedAt = performance.now();

    const err = await gatewayError(gateway);

    // six calls of 100 ms each were allowed; the budget cut the second one
    expect(err.retryable).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(TIMEOUT_MS * 3);
    expect(psp.calls).toHaveLength(2);
  });

  it('makes no further call when the budget ends during a pause', async () => {
    const psp = script(CHARGES_URL, throttled('1'), throttled('1'));
    const gateway = httpGateway(
      config({ pspMaxRetries: 2, pspRetryMaxDelayMs: 1500, pspCallBudgetMs: 200 }),
    );

    const err = await gatewayError(gateway);

    expect(err).toMatchObject({ retryable: true, message: 'PSP did not answer within 200 ms' });
    expect(psp.calls).toHaveLength(1);
  });
});

describe('HttpPaymentGateway: a provider that keeps failing is not called (PAY-030)', () => {
  const HALF_OPEN_MS = 100;
  // opens once more than half of at least four calls have failed
  const guarded = (overrides: Partial<GatewayConfig> = {}): HttpPaymentGateway =>
    httpGateway(
      config({ pspBreakerMinCalls: 4, pspBreakerHalfOpenMs: HALF_OPEN_MS, ...overrides }),
    );
  const fail = async (gateway: PaymentGateway, times: number): Promise<void> => {
    for (let i = 0; i < times; i += 1) await gatewayError(gateway);
  };
  const OPEN = { retryable: true, message: 'PSP circuit is open: not called' };

  it('opens after enough failed calls and fails at once, without a call', async () => {
    const psp = script(CHARGES_URL, ...repeat(503, 10));
    const gateway = guarded();

    await fail(gateway, 4);
    const startedAt = performance.now();
    const err = await gatewayError(gateway);

    expect(err).toMatchObject(OPEN);
    expect(performance.now() - startedAt).toBeLessThan(TIMEOUT_MS / 2);
    expect(psp.calls).toHaveLength(4);
  });

  it('says nothing on fewer calls than it needs to judge', async () => {
    const psp = script(CHARGES_URL, ...repeat(503, 3));
    const gateway = guarded();

    await fail(gateway, 3);

    await expect(gateway.charge(request())).resolves.toMatchObject({ status: 'succeeded' });
    expect(psp.calls).toHaveLength(4);
  });

  it('stays closed while no more than half of the calls fail', async () => {
    const psp = script(CHARGES_URL, 'ok', 'ok', 'ok', 503, 503, 503);
    const gateway = guarded();

    for (let i = 0; i < 3; i += 1) await gateway.charge(request());
    await fail(gateway, 3);

    // three of six: at the threshold, not above it
    await expect(gateway.charge(request())).resolves.toMatchObject({ status: 'succeeded' });
    expect(psp.calls).toHaveLength(7);
  });

  it.each<[string, Answer]>([
    ['a refusal (400)', 400],
    ['a malformed body', 'malformed'],
  ])('does not count %s: the provider is there', async (_, answer) => {
    const psp = script(CHARGES_URL, ...repeat(answer, 6));
    const gateway = guarded();

    await fail(gateway, 6);

    await expect(gateway.charge(request())).resolves.toMatchObject({ status: 'succeeded' });
    expect(psp.calls).toHaveLength(7);
  });

  it('does not count a decline', async () => {
    const psp = script(CHARGES_URL, ...repeat('declined', 6));
    const gateway = guarded();

    for (let i = 0; i < 7; i += 1) await gateway.charge(request());

    expect(psp.calls).toHaveLength(7);
  });

  it('lets one call through after a while, and closes when it passes', async () => {
    const psp = script(CHARGES_URL, ...repeat(503, 4));
    const gateway = guarded();
    await fail(gateway, 4);
    await gatewayError(gateway); // open

    await delay(HALF_OPEN_MS + 20);

    await expect(gateway.charge(request())).resolves.toMatchObject({ status: 'succeeded' });
    await expect(gateway.charge(request())).resolves.toMatchObject({ status: 'succeeded' });
    expect(psp.calls).toHaveLength(6);
  });

  it('opens again when that call fails', async () => {
    const psp = script(CHARGES_URL, ...repeat(503, 5));
    const gateway = guarded();
    await fail(gateway, 4);

    await delay(HALF_OPEN_MS + 20);

    expect(await gatewayError(gateway)).toMatchObject({ message: 'PSP responded 503' });
    expect(await gatewayError(gateway)).toMatchObject(OPEN);
    expect(psp.calls).toHaveLength(5);
  });

  it('is one for the provider: failed charges stop a void too', async () => {
    script(CHARGES_URL, ...repeat(503, 4));
    const voids = script(VOID_URL);
    const gateway = guarded();
    await fail(gateway, 4);

    await expect(gateway.void('ch_1')).rejects.toMatchObject(OPEN);
    expect(voids.calls).toHaveLength(0);
  });

  it('ends the retries of an operation the moment it opens', async () => {
    const psp = script(CHARGES_URL, ...repeat(503, 10));
    const gateway = guarded({ pspMaxRetries: 5 });

    const err = await gatewayError(gateway);

    // the fourth failed call opened it; the retry after that was not made
    expect(err).toMatchObject(OPEN);
    expect(psp.calls).toHaveLength(4);
  });
});

describe('HttpPaymentGateway: the chain a call belongs to (LOG-040)', () => {
  const CORRELATION_ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03';

  /** The `x-correlation-id` of every call the provider got. */
  function chains(): (string | null)[] {
    const seen: (string | null)[] = [];
    server.use(
      http.post(CHARGES_URL, ({ request: req }) => {
        seen.push(req.headers.get('x-correlation-id'));
        return HttpResponse.json({ id: 'ch_1', status: 'succeeded' }, { status: 201 });
      }),
      http.post(`${CHARGES_URL}/:id/void`, ({ request: req }) => {
        seen.push(req.headers.get('x-correlation-id'));
        return HttpResponse.json({ status: 'voided' });
      }),
    );
    return seen;
  }

  it('names the chain of the command on a charge and on a void', async () => {
    const seen = chains();
    const gateway = httpGateway(config(), CORRELATION_ID);

    await gateway.charge(request());
    await gateway.void('ch_1');

    expect(seen).toEqual([CORRELATION_ID, CORRELATION_ID]);
  });

  it('sends no such header for a call that belongs to no chain', async () => {
    const seen = chains();

    await httpGateway(config()).charge(request());

    expect(seen).toEqual([null]);
  });
});

describe('HttpPaymentGateway: what it counts (MET-040, MET-041)', () => {
  const HALF_OPEN_MS = 100;
  const measured = (overrides: Partial<GatewayConfig> = {}) => {
    const metrics = new RecordingMetrics();
    const gateway = new HttpPaymentGateway(
      config({ pspBreakerMinCalls: 4, pspBreakerHalfOpenMs: HALF_OPEN_MS, ...overrides }),
      silentLogger,
      { current: () => undefined },
      metrics,
    );
    const circuit = () => metrics.of('circuit_breaker_state').at(-1)?.value;
    return { gateway, metrics, circuit };
  };
  const calls = (metrics: RecordingMetrics) =>
    metrics.of('outbound_call_duration_seconds').map((sample) => sample.labels);

  it('MET-040 observes every call by its operation and the status of the provider', async () => {
    const { gateway, metrics } = measured();

    await gateway.charge(request());
    await gateway.void('ch_1');

    expect(calls(metrics)).toEqual([
      { vendor: 'psp', operation: 'charge', status: 201 },
      { vendor: 'psp', operation: 'void', status: 200 },
    ]);
  });

  it('MET-040 observes a failed call too, and one the provider never answered', async () => {
    script(CHARGES_URL, 503);
    const { gateway, metrics } = measured();
    await gatewayError(gateway);
    server.use(http.post(CHARGES_URL, () => HttpResponse.error()));
    await gatewayError(gateway);

    expect(calls(metrics).map(({ status }) => status)).toEqual([503, 'no_answer']);
  });

  it('MET-040 never puts a charge id on a series: a void is one operation', async () => {
    const { gateway, metrics } = measured();
    await gateway.charge(request());

    await gateway.void('ch_1');

    expect(JSON.stringify(calls(metrics))).not.toContain('ch_1');
  });

  it('MET-041 says the circuit is closed from the start, open when it opens, and closed again', async () => {
    script(CHARGES_URL, ...repeat(503, 4));
    const { gateway, metrics, circuit } = measured();
    expect(circuit()).toBe(CIRCUIT.closed);

    for (let i = 0; i < 4; i += 1) await gatewayError(gateway);
    expect(circuit()).toBe(CIRCUIT.open);

    // not called: counted as rejected, and no call is observed
    await gatewayError(gateway);
    expect(metrics.total('circuit_breaker_rejected_total', { vendor: 'psp' })).toBe(1);
    expect(calls(metrics)).toHaveLength(4);

    await delay(HALF_OPEN_MS + 20);
    await gateway.charge(request());
    expect(metrics.of('circuit_breaker_state').map((sample) => sample.value)).toEqual([
      CIRCUIT.closed,
      CIRCUIT.open,
      CIRCUIT.halfOpen,
      CIRCUIT.closed,
    ]);
  });
});
