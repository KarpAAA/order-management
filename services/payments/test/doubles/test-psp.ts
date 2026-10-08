// An in-process payment provider for the service in e2e tests: scriptable per order, and
// idempotent by key like a real PSP. It replaces PAYMENT_GATEWAY (the port), so the HTTP
// adapter is not exercised here: its spec runs it against MSW.
import { PaymentGatewayError } from '@modules/payments/infrastructure/payment-gateway.error';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentGateway,
} from '@modules/payments/ports/payment-gateway.port';

/**
 * - `ok` → succeeded;
 * - `declined:<code>` → a decline (a business result, not an error);
 * - `unavailable` → transient transport failure (503 / timeout);
 * - `rejected` → non-transient failure (other 4xx, malformed body);
 * - `broken` → not a failure of the provider at all: a bug on our side of the call.
 */
export type PspOutcome = 'ok' | `declined:${string}` | 'unavailable' | 'rejected' | 'broken';

export class TestPsp implements PaymentGateway {
  private readonly scripts = new Map<string, PspOutcome[]>();
  private readonly requests: ChargeRequest[] = [];
  /** What the provider settled, by idempotency key: a repeated key gets the same answer. */
  private readonly settled = new Map<string, ChargeResult>();
  private readonly barriers = new Map<string, { expected: number; arrived: (() => void)[] }>();
  private readonly held = new Map<string, Promise<void>>();
  private readonly voided: string[] = [];
  private voidFailures = 0;

  /** Answers for the next charges of `orderId`, in order; after the script runs out: `ok`. */
  script(orderId: string, ...outcomes: PspOutcome[]): void {
    this.scripts.set(orderId, outcomes);
  }

  /**
   * Holds every charge of `orderId` until `calls` of them have arrived (or 5 s passed): forces
   * two consumers to be inside the charge at the same time, both past the "is it still pending?"
   * check — the race only the idempotency key protects against.
   */
  holdUntilConcurrent(orderId: string, calls: number): void {
    this.barriers.set(orderId, { expected: calls, arrived: [] });
  }

  /**
   * Holds every charge of `orderId` inside the provider until the returned function is called:
   * the test does something else while the call is in flight.
   */
  hold(orderId: string): () => void {
    let release: () => void = () => undefined;
    this.held.set(
      orderId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      this.held.delete(orderId);
      release();
    };
  }

  /** The next `times` voids fail as a provider that is away does. */
  failVoids(times: number): void {
    this.voidFailures = times;
  }

  /** Charge ids the provider was asked to take back, repetitions included. */
  voids(orderId: string): string[] {
    return this.voided.filter((chargeId) => chargeId.startsWith(`ch_${orderId}:`));
  }

  /** Every charge request for the order, including retries and replays. */
  calls(orderId: string): ChargeRequest[] {
    return this.requests.filter((r) => r.reference === orderId);
  }

  /** Charges the provider actually created for the order (one per idempotency key). */
  charges(orderId: string): ChargeResult[] {
    return [...this.settled.entries()]
      .filter(([key]) => key.startsWith(`${orderId}:`))
      .map(([, result]) => result);
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    this.requests.push(request);
    await this.meet(request.reference);
    await this.held.get(request.reference);
    const known = this.settled.get(request.idempotencyKey);
    if (known) return known;

    const outcome = this.scripts.get(request.reference)?.shift() ?? 'ok';
    if (outcome === 'unavailable') {
      throw new PaymentGatewayError('PSP answered 503', true);
    }
    if (outcome === 'rejected') {
      throw new PaymentGatewayError('PSP answered 400', false);
    }
    if (outcome === 'broken') {
      throw new TypeError('cannot read the charge');
    }
    const chargeId = `ch_${request.idempotencyKey}`;
    const result: ChargeResult =
      outcome === 'ok'
        ? { status: 'succeeded', chargeId }
        : { status: 'declined', chargeId, declineCode: outcome.slice('declined:'.length) };
    this.settled.set(request.idempotencyKey, result);
    return result;
  }

  void(chargeId: string): Promise<void> {
    this.voided.push(chargeId);
    if (this.voidFailures > 0) {
      this.voidFailures -= 1;
      return Promise.reject(new PaymentGatewayError('PSP answered 503', true));
    }
    return Promise.resolve();
  }

  private async meet(orderId: string): Promise<void> {
    const barrier = this.barriers.get(orderId);
    if (!barrier) return;
    await new Promise<void>((resolve) => {
      barrier.arrived.push(resolve);
      if (barrier.arrived.length >= barrier.expected) {
        this.barriers.delete(orderId);
        barrier.arrived.forEach((release) => {
          release();
        });
      } else {
        setTimeout(resolve, 5000); // never hang the suite if the second caller does not come
      }
    });
  }
}
