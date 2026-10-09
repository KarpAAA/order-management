// The payment provider of the stack (devtools/fake-psp), as its operator: how it behaves, and
// what it was asked to charge. It is one for the run, and so are its settings: a scenario
// that changes them gives them back (`restore()`).
import { stack } from '../setup/stack';

export interface Behaviour {
  latencyMs: number;
  failureRate: number;
  throttleRate: number;
  declineRate: number;
}

export interface Charge {
  id: string;
  status: 'succeeded' | 'declined';
  amountMinor: number;
  currency: string;
  /** The order the charge is for. */
  reference: string;
  idempotencyKey: string;
  /** Set when the charge was taken back. */
  voidedAt?: string;
}

/** What docker-compose.yml starts the provider with. */
const DEFAULTS: Behaviour = { latencyMs: 200, failureRate: 0, throttleRate: 0, declineRate: 0 };

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, stack.psp), {
    method,
    ...(body !== undefined && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
  if (!response.ok) {
    throw new Error(`fake-psp ${method} ${path} answered ${response.status}`);
  }
  return (await response.json()) as T;
}

export const psp = {
  configure: (behaviour: Partial<Behaviour>): Promise<Behaviour> =>
    call('POST', '/admin/config', behaviour),

  restore: (): Promise<Behaviour> => call('POST', '/admin/config', DEFAULTS),

  /** Every charge the provider was asked for on behalf of the order, in the order asked. */
  async chargesOf(orderId: string): Promise<Charge[]> {
    const charges = await call<Charge[]>('GET', '/charges');
    return charges.filter((charge) => charge.reference === orderId);
  },

  /** Calls the provider has taken and not answered yet. */
  async inFlight(): Promise<number> {
    const { inFlight } = await call<{ inFlight: number }>('GET', '/admin/stats');
    return inFlight;
  },
};
