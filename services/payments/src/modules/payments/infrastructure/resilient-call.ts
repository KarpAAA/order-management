import {
  BrokenCircuitError,
  circuitBreaker,
  ExponentialBackoff,
  handleWhen,
  retry,
  SamplingBreaker,
  wrap,
  type CircuitBreakerPolicy,
  type IBackoff,
  type IBackoffFactory,
  type IRetryBackoffContext,
  type RetryPolicy,
} from 'cockatiel';

import type { GatewayConfig } from '@config/configuration';
import type { Logger } from '@shared/logger/logger';
import type { Metrics } from '@shared/observability/metrics';
import { silentMetrics } from '@shared/observability/silent-metrics';

import { PaymentGatewayError } from './payment-gateway.error';

/** One call of an operation: which one it is (1 = the first), and the signal that ends it. */
export interface CallAttempt {
  number: number;
  signal: AbortSignal;
}

export interface ResilientCall {
  /** Resolves with what `call` returned, or throws a `PaymentGatewayError`. */
  execute<T>(call: (attempt: CallAttempt) => Promise<T>): Promise<T>;
}

type RetryContext = IRetryBackoffContext<unknown>;

/** The time of the whole operation ran out between two calls: the provider was not called. */
class BudgetExhausted extends Error {}

const isTransient = (err: unknown): err is PaymentGatewayError =>
  err instanceof PaymentGatewayError && err.retryable;

const messageOf = (reason: unknown): string => {
  const err =
    typeof reason === 'object' && reason !== null && 'error' in reason ? reason.error : reason;
  return err instanceof Error ? err.message : String(err);
};

/**
 * `Retry-After` as milliseconds from `now`: a number of seconds or an HTTP date. Anything
 * else is no answer: the pause is ours to choose.
 */
export function parseRetryAfter(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // an HTTP date ends in GMT; `Date.parse` alone makes a date of almost anything ("-1")
  const at = value.endsWith('GMT') ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

/** The pause the provider asked for, where it asked; the growing one with jitter otherwise. */
function pauses(exponential: IBackoffFactory<unknown>): IBackoffFactory<RetryContext> {
  const step = (inner: IBackoff<unknown>, context: RetryContext): IBackoff<RetryContext> => ({
    duration:
      ('error' in context.result && isTransient(context.result.error)
        ? context.result.error.retryAfterMs
        : undefined) ?? inner.duration,
    next: (next) => step(inner.next(next), next),
  });
  return { next: (context) => step(exponential.next(context), context) };
}

function retries(config: GatewayConfig, logger: Logger): RetryPolicy {
  const policy = retry(
    // a pause the provider asks for that is longer than ours is not sat out in the process
    handleWhen((err) => isTransient(err) && (err.retryAfterMs ?? 0) <= config.pspRetryMaxDelayMs),
    {
      maxAttempts: config.pspMaxRetries,
      backoff: pauses(
        new ExponentialBackoff({
          initialDelay: config.pspRetryInitialDelayMs,
          maxDelay: config.pspRetryMaxDelayMs,
        }),
      ),
    },
  );
  policy.onRetry(({ attempt, delay, ...reason }) => {
    logger.warn(
      {
        retry: attempt,
        maxRetries: config.pspMaxRetries,
        delayMs: Math.round(delay),
        reason: messageOf(reason),
      },
      'psp call failed, called again after a pause',
    );
  });
  return policy;
}

/** The state of the circuit as a number a graph can show: the higher, the less is called. */
export const CIRCUIT = { closed: 0, halfOpen: 1, open: 2 } as const;

function breaker(config: GatewayConfig, logger: Logger, metrics: Metrics): CircuitBreakerPolicy {
  const state = metrics.gauge({
    name: 'circuit_breaker_state',
    help: 'State of the circuit of a vendor: 0 closed, 1 half-open, 2 open.',
    labels: ['vendor'],
  });
  const vendor = { vendor: 'psp' };
  // said at once: a circuit that never opened is closed, not unknown
  state.set(vendor, CIRCUIT.closed);
  const policy = circuitBreaker(handleWhen(isTransient), {
    halfOpenAfter: config.pspBreakerHalfOpenMs,
    breaker: new SamplingBreaker({
      threshold: config.pspBreakerThreshold,
      duration: config.pspBreakerWindowMs,
      // the library asks for a rate; half a call below the number keeps the rounding of
      // its window from asking for one call more
      minimumRps: (config.pspBreakerMinCalls - 0.5) / (config.pspBreakerWindowMs / 1000),
    }),
  });
  policy.onBreak((reason) => {
    state.set(vendor, CIRCUIT.open);
    logger.error(
      { openForMs: config.pspBreakerHalfOpenMs, reason: messageOf(reason) },
      'psp circuit opened',
    );
  });
  policy.onHalfOpen(() => {
    state.set(vendor, CIRCUIT.halfOpen);
    logger.warn({}, 'psp circuit half-open: one call decides');
  });
  policy.onReset(() => {
    state.set(vendor, CIRCUIT.closed);
    logger.info({}, 'psp circuit closed');
  });
  return policy;
}

/**
 * What stands between the service and its provider (docs/adr/0020). Two things, the retry
 * around the breaker, so that the breaker sees every call:
 *  - a call that failed in a way that may pass is made again after a pause, a few times:
 *    for a provider that hiccups;
 *  - once too many calls of the last seconds have failed, the provider is not called at
 *    all for a while, and every operation fails at once: for a provider that is down.
 * Both look only at `PaymentGatewayError.retryable`. A decline, a refusal (4xx) and a
 * malformed body are answers of a provider that is there: not repeated, not counted.
 *
 * Whatever is given up here is thrown as retryable, and the command comes again from its
 * wait queue (docs/adr/0013): the retry here is for milliseconds, that one for an outage.
 * One instance per provider, shared by all its operations: the state is the provider's.
 */
export function createResilientCall(
  config: GatewayConfig,
  logger: Logger,
  metrics: Metrics = silentMetrics,
): ResilientCall {
  const policy = wrap(retries(config, logger), breaker(config, logger, metrics));
  const rejected = metrics.counter({
    name: 'circuit_breaker_rejected_total',
    help: 'Operations that failed at once because the circuit of a vendor was open.',
    labels: ['vendor'],
  });

  return {
    async execute(call) {
      const budget = AbortSignal.timeout(config.pspCallBudgetMs);
      try {
        return await policy.execute(({ attempt, signal }) => {
          // ran out during a pause: not a call, so nothing for the breaker to count
          if (signal.aborted) throw new BudgetExhausted();
          return call({
            number: attempt + 1,
            signal: AbortSignal.any([signal, AbortSignal.timeout(config.pspTimeoutMs)]),
          });
        }, budget);
      } catch (err: unknown) {
        if (err instanceof BrokenCircuitError) {
          rejected.inc({ vendor: 'psp' });
          throw new PaymentGatewayError('PSP circuit is open: not called', true, { cause: err });
        }
        if (err instanceof BudgetExhausted) {
          throw new PaymentGatewayError(
            `PSP did not answer within ${String(config.pspCallBudgetMs)} ms`,
            true,
          );
        }
        throw err;
      }
    },
  };
}
