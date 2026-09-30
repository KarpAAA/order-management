import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DomainError } from '@shared/errors/domain-error';

import {
  CURRENCY,
  NOW,
  TAX_RATE_BPS,
  USER,
  WORKSPACE,
  change,
  lineInputs,
} from './__test__/builders';
import { NO_DISCOUNT } from './discount';
import { Order } from './order';

// Every action a caller or the payment flow can take. Invalid ones throw a domain error and are
// part of the sequence too: a refused transition must leave nothing behind either.
type Action = (order: Order) => void;
const ACTIONS: Record<string, Action> = {
  place: (o) => {
    o.place(change());
  },
  cancel: (o) => {
    o.cancel(change());
  },
  fulfill: (o) => {
    o.fulfill(change());
  },
  pay: (o) => {
    o.markPaid({ ...change(), attempt: o.snapshot().paymentAttempt, pspChargeId: 'ch_1' });
  },
  decline: (o) => {
    o.markPaymentFailed({ ...change(), attempt: o.snapshot().paymentAttempt, reason: 'declined' });
  },
  edit: (o) => {
    o.replaceContents({ lines: lineInputs(2), discount: NO_DISCOUNT, now: NOW });
  },
};
const actionsArb = fc.array(fc.constantFrom(...Object.keys(ACTIONS)), { maxLength: 8 });

/** Applies the actions in order; each refused one must leave the order exactly as it was. */
function run(names: readonly string[]): Order {
  const order = Order.draft({
    workspaceId: WORKSPACE,
    currency: CURRENCY,
    taxRateBps: TAX_RATE_BPS,
    lines: lineInputs(1),
    createdBy: USER,
    now: NOW,
  });
  for (const name of names) {
    const before = structuredClone(order.snapshot());
    order.pullHistory(); // drop what earlier actions recorded; only this action's entries remain
    try {
      ACTIONS[name]?.(order);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      expect(order.snapshot()).toEqual(before);
      expect(order.pullHistory()).toEqual([]);
    }
  }
  return order;
}

describe('Order invariants (quality/testing.md §2)', () => {
  it('a refused action changes nothing: no field, no history (ORD-022)', () => {
    fc.assert(
      fc.property(actionsArb, (names) => {
        run(names);
      }),
    );
  });

  it('restore(snapshot()) round-trips after any sequence of actions', () => {
    fc.assert(
      fc.property(actionsArb, (names) => {
        const order = run(names);
        const restored = Order.restore(order.snapshot());

        expect(restored.snapshot()).toEqual(order.snapshot());
        expect(restored.amountDue).toEqual(order.amountDue);
      }),
    );
  });

  it('never changes version: the repository increments it per save (ORD-010)', () => {
    fc.assert(
      fc.property(actionsArb, (names) => {
        expect(run(names).snapshot().version).toBe(0);
      }),
    );
  });
});
