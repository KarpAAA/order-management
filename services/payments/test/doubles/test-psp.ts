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
 * - `rejected` → non-transient failure (other 4xx, malformed body).
 */
export type PspOutcome = 'ok' | `declined:${string}` | 'unavailable' | 'rejected';

export class TestPsp implements PaymentGateway {
  private readonly scripts = new Map<string, PspOutcome[]>();
  private readonly requests: ChargeRequest[] = [];
  /** What the provider settled, by idempotency key: a repeated key gets the same answer. */
  private readonly settled = new Map<string, ChargeResult>();
  private readonly barriers = new Map<string, { expected: number; arrived: (() => void)[] }>();

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
    const known = this.settled.get(request.idempotencyKey);
    if (known) return known;

    const outcome = this.scripts.get(request.reference)?.shift() ?? 'ok';
    if (outcome === 'unavailable') {
      throw new PaymentGatewayError('PSP answered 503', true);
    }
    if (outcome === 'rejected') {
      throw new PaymentGatewayError('PSP answered 400', false);
    }
    const chargeId = `ch_${request.idempotencyKey}`;
    const result: ChargeResult =
      outcome === 'ok'
        ? { status: 'succeeded', chargeId }
        : { status: 'declined', chargeId, declineCode: outcome.slice('declined:'.length) };
    this.settled.set(request.idempotencyKey, result);
    return result;
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
