import { describe, expect, it } from 'vitest';

import { systemActor } from '@shared/auth/actor';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { PaymentsPolicy } from './payments.policy';

const policy = new PaymentsPolicy();

describe.each([
  ['assertCanCharge', policy.assertCanCharge.bind(policy)],
  ['assertCanCancel', policy.assertCanCancel.bind(policy)],
])('PaymentsPolicy.%s (PAY-013)', (_name, assert) => {
  it('lets the payments consumer through', () => {
    expect(() => {
      assert(systemActor('consumer:payments'));
    }).not.toThrow();
  });

  it.each(['consumer:orders', 'job:reconcile', 'consumer:payments2'])('refuses %s', (source) => {
    expect(() => {
      assert(systemActor(source));
    }).toThrow(ForbiddenError);
  });
});
