import { describe, expect, it } from 'vitest';

import { systemActor } from '@shared/auth/actor';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { PaymentsPolicy } from './payments.policy';

describe('PaymentsPolicy.assertCanCharge', () => {
  const policy = new PaymentsPolicy();

  it('lets the payments consumer charge', () => {
    expect(() => {
      policy.assertCanCharge(systemActor('consumer:payments'));
    }).not.toThrow();
  });

  it.each(['consumer:orders', 'job:reconcile', 'consumer:payments2'])('refuses %s', (source) => {
    expect(() => {
      policy.assertCanCharge(systemActor(source));
    }).toThrow(ForbiddenError);
  });
});
