import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEADLINE, LATER, NOW, ORDER, sagaIn, WORKSPACE } from './__test__/builders';
import { OrderSagaNotWaitingError } from './errors';
import { OrderSaga } from './order-saga';
import { OrderSagaStep, WAITING_STEPS } from './order-saga-step';

import type { WaitingStep } from './order-saga-step';

/**
 * The whole process: every step × every fact that can arrive.
 *
 * The expected table is copied by hand from docs/requirements.md → SAGA, on purpose not
 * built from the class: a test derived from the code it tests would agree with any bug.
 */

type Fact =
  'stockReserved' | 'stockRefused' | 'paymentSucceeded' | 'paymentEnded' | 'stockReleased';

const FACTS: readonly Fact[] = [
  'stockReserved',
  'stockRefused',
  'paymentSucceeded',
  'paymentEnded',
  'stockReleased',
];

const ACCEPTED: readonly { step: OrderSagaStep; fact: Fact; next: OrderSagaStep }[] = [
  { step: OrderSagaStep.Reserving, fact: 'stockReserved', next: OrderSagaStep.Charging },
  { step: OrderSagaStep.Reserving, fact: 'stockRefused', next: OrderSagaStep.Aborted },
  { step: OrderSagaStep.Charging, fact: 'paymentSucceeded', next: OrderSagaStep.Completed },
  { step: OrderSagaStep.Charging, fact: 'paymentEnded', next: OrderSagaStep.Releasing },
  {
    step: OrderSagaStep.CancellingPayment,
    fact: 'paymentSucceeded',
    next: OrderSagaStep.Completed,
  },
  { step: OrderSagaStep.CancellingPayment, fact: 'paymentEnded', next: OrderSagaStep.Releasing },
  { step: OrderSagaStep.Releasing, fact: 'stockReleased', next: OrderSagaStep.Aborted },
];

const REFUSED = Object.values(OrderSagaStep).flatMap((step) =>
  FACTS.filter((fact) => !ACCEPTED.some((a) => a.step === step && a.fact === fact)).map((fact) => ({
    step,
    fact,
  })),
);

const ENDED: readonly OrderSagaStep[] = [OrderSagaStep.Completed, OrderSagaStep.Aborted];

const TIMEOUTS: readonly { step: WaitingStep; next: OrderSagaStep; action: string }[] = [
  { step: OrderSagaStep.Reserving, next: OrderSagaStep.Releasing, action: 'release-stock' },
  {
    step: OrderSagaStep.Charging,
    next: OrderSagaStep.CancellingPayment,
    action: 'cancel-payment',
  },
  {
    step: OrderSagaStep.CancellingPayment,
    next: OrderSagaStep.CancellingPayment,
    action: 'repeat-cancel-payment',
  },
  {
    step: OrderSagaStep.Releasing,
    next: OrderSagaStep.Releasing,
    action: 'repeat-release-stock',
  },
];

describe('OrderSaga.start', () => {
  it('SAGA-001 begins in RESERVING at version 0, with the deadline of the step', () => {
    const saga = OrderSaga.start({
      workspaceId: WORKSPACE,
      orderId: ORDER,
      attempt: 2,
      now: NOW,
      deadline: DEADLINE,
    });

    expect(saga.snapshot()).toEqual({
      workspaceId: WORKSPACE,
      orderId: ORDER,
      attempt: 2,
      step: OrderSagaStep.Reserving,
      deadlineAt: DEADLINE,
      version: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(saga.waitingIn).toBe(OrderSagaStep.Reserving);
  });
});

describe('OrderSaga: a fact that arrives', () => {
  it('covers 6 steps × 5 facts: 7 accepted, 23 refused', () => {
    expect(ACCEPTED).toHaveLength(7);
    expect(REFUSED).toHaveLength(23);
  });

  it.each(ACCEPTED)('SAGA accepts $fact in $step and moves to $next', ({ step, fact, next }) => {
    const saga = sagaIn(step);
    const version = saga.version;

    saga[fact](LATER);

    expect(saga.step).toBe(next);
    expect(saga.snapshot().updatedAt).toEqual(LATER);
    // the repository bumps the version on save; the domain never touches it
    expect(saga.version).toBe(version);
  });

  it.each(ACCEPTED.filter(({ next }) => ENDED.includes(next)))(
    '$fact in $step ends the saga: nothing is waited for',
    ({ step, fact }) => {
      const saga = sagaIn(step);

      saga[fact](LATER);

      expect(saga.snapshot().deadlineAt).toBeNull();
      expect(saga.waitingIn).toBeNull();
    },
  );

  it.each(ACCEPTED.filter(({ next }) => !ENDED.includes(next)))(
    '$fact in $step begins a step that waits, whose deadline is still to be told',
    ({ step, fact, next }) => {
      const saga = sagaIn(step);

      saga[fact](LATER);

      expect(saga.snapshot().deadlineAt).toBeNull();
      expect(saga.waitingIn).toBe(next);
    },
  );

  it.each(REFUSED)('SAGA-011 refuses $fact in $step and changes nothing', ({ step, fact }) => {
    const saga = sagaIn(step);
    const before = saga.snapshot();

    expect(() => {
      saga[fact](LATER);
    }).toThrow(OrderSagaNotWaitingError);

    expect(saga.snapshot()).toEqual(before);
  });

  it('SAGA-011 says what was refused, and where the saga is', () => {
    expect(() => {
      sagaIn(OrderSagaStep.Aborted).paymentSucceeded(LATER);
    }).toThrow(
      expect.objectContaining({
        code: 'ORDER_SAGA_NOT_WAITING',
        details: {
          orderId: ORDER,
          attempt: 1,
          fact: 'payment succeeded',
          step: OrderSagaStep.Aborted,
        },
      }),
    );
  });
});

describe('OrderSaga.timedOut', () => {
  it.each(TIMEOUTS)(
    'SAGA-007 SAGA-008 SAGA-009 the timeout of $step moves to $next and asks for $action',
    ({ step, next, action }) => {
      const saga = sagaIn(step);

      expect(saga.timedOut(step, LATER)).toBe(action);

      expect(saga.step).toBe(next);
      expect(saga.snapshot()).toMatchObject({ deadlineAt: null, updatedAt: LATER });
    },
  );

  const stale = Object.values(OrderSagaStep).flatMap((step) =>
    WAITING_STEPS.filter((timeout) => timeout !== step).map((timeout) => ({ step, timeout })),
  );

  it.each(stale)(
    'SAGA-010 the timeout of $timeout does not count once the saga is $step',
    ({ step, timeout }) => {
      const saga = sagaIn(step);
      const before = saga.snapshot();

      expect(() => saga.timedOut(timeout, LATER)).toThrow(OrderSagaNotWaitingError);

      expect(saga.snapshot()).toEqual(before);
    },
  );
});

describe('OrderSaga.waitUntil', () => {
  it.each(WAITING_STEPS)('sets the deadline of %s', (step) => {
    const saga = sagaIn(step, { deadlineAt: null });

    saga.waitUntil(DEADLINE);

    expect(saga.snapshot().deadlineAt).toEqual(DEADLINE);
  });

  it.each(ENDED)('refuses a deadline for a saga that is %s', (step) => {
    const saga = sagaIn(step);

    expect(() => {
      saga.waitUntil(DEADLINE);
    }).toThrow(OrderSagaNotWaitingError);
    expect(saga.snapshot().deadlineAt).toBeNull();
  });
});

describe('OrderSaga: any order of facts and timeouts', () => {
  const fact = fc.constantFrom(...FACTS).map((name) => ({ kind: 'fact' as const, name }));
  const timeout = fc
    .constantFrom(...WAITING_STEPS)
    .map((step) => ({ kind: 'timeout' as const, step }));

  const apply = (
    saga: OrderSaga,
    event: { kind: 'fact'; name: Fact } | { kind: 'timeout'; step: WaitingStep },
  ): boolean => {
    try {
      if (event.kind === 'fact') saga[event.name](LATER);
      else saga.timedOut(event.step, LATER);
      return true;
    } catch (err: unknown) {
      if (err instanceof OrderSagaNotWaitingError) return false;
      throw err;
    }
  };

  it('never leaves the graph: a refused event changes nothing, and an ended saga stays ended', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fact, timeout), { maxLength: 30 }), (events) => {
        const saga = OrderSaga.start({
          workspaceId: WORKSPACE,
          orderId: ORDER,
          attempt: 1,
          now: NOW,
          deadline: DEADLINE,
        });
        for (const event of events) {
          const before = saga.snapshot();
          const accepted = apply(saga, event);
          if (!accepted) expect(saga.snapshot()).toEqual(before);
          if (ENDED.includes(before.step)) expect(accepted).toBe(false);
        }
      }),
    );
  });

  it('is paid only through a charge: COMPLETED is reached from CHARGING or CANCELLING_PAYMENT', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fact, timeout), { maxLength: 30 }), (events) => {
        const saga = OrderSaga.start({
          workspaceId: WORKSPACE,
          orderId: ORDER,
          attempt: 1,
          now: NOW,
          deadline: DEADLINE,
        });
        for (const event of events) {
          const before = saga.step;
          apply(saga, event);
          if (saga.step === OrderSagaStep.Completed && before !== OrderSagaStep.Completed) {
            expect([OrderSagaStep.Charging, OrderSagaStep.CancellingPayment]).toContain(before);
          }
        }
      }),
    );
  });
});
