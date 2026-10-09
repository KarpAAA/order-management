import { describe, expect, it } from 'vitest';

import { systemActor } from '@shared/auth/actor';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { InventoryPolicy } from './inventory.policy';

const policy = new InventoryPolicy();

const CHECKS = [
  { action: 'inventory.reserve', check: policy.assertCanReserve.bind(policy) },
  { action: 'inventory.release', check: policy.assertCanRelease.bind(policy) },
  { action: 'inventory.adjust', check: policy.assertCanAdjust.bind(policy) },
];

describe.each(CHECKS)('InventoryPolicy: $action', ({ action, check }) => {
  it('lets the consumer of the service through', () => {
    expect(() => {
      check(systemActor('consumer:inventory'));
    }).not.toThrow();
  });

  it.each(['consumer:orders', 'consumer:payments', 'job:cleanup-outbox'])(
    'refuses %s, naming the action',
    (source) => {
      expect(() => {
        check(systemActor(source));
      }).toThrow(expect.objectContaining({ action }));
      expect(() => {
        check(systemActor(source));
      }).toThrow(ForbiddenError);
    },
  );
});
