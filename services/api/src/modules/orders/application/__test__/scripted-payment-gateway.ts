import type { ChargeRequest, ChargeResult, PaymentGateway } from '../../ports/payment-gateway.port';

type Scripted = { kind: 'result'; result: ChargeResult } | { kind: 'error'; error: Error };

/**
 * Stub + spy: answers `charge` with whatever the test scripted, and records every request.
 * Unlike the infrastructure `FakePaymentGateway` (decides by amount, never throws), it can
 * produce any outcome on demand, including transport failures.
 */
export class ScriptedPaymentGateway implements PaymentGateway {
  readonly requests: ChargeRequest[] = [];
  private next: Scripted = { kind: 'result', result: { status: 'succeeded', chargeId: 'ch_1' } };

  willReturn(result: ChargeResult): void {
    this.next = { kind: 'result', result };
  }

  willThrow(error: Error): void {
    this.next = { kind: 'error', error };
  }

  charge(request: ChargeRequest): Promise<ChargeResult> {
    this.requests.push(request);
    return this.next.kind === 'result'
      ? Promise.resolve(this.next.result)
      : Promise.reject(this.next.error);
  }
}
