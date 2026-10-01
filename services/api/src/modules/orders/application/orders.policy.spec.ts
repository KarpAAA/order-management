import { describe, expect, it } from 'vitest';

import { systemActor, userActor } from '@shared/auth/actor';
import type { Actor } from '@shared/auth/actor';
import { WorkspaceRole } from '@shared/auth/workspace-role';
import type { WorkspaceMembership } from '@shared/auth/workspace-role';
import { ForbiddenError } from '@shared/errors/forbidden-error';

import { USER, WORKSPACE } from '../domain/__test__/builders';

import { OrdersPolicy } from './orders.policy';

/**
 * docs/requirements.md → PERM (orders rows) and PAY-013, copied by hand on purpose: a table
 * derived from ORDER_WRITERS / ORDER_FULFILLERS would agree with any change to them.
 */
const PERM: readonly { role: WorkspaceRole; write: boolean; fulfill: boolean }[] = [
  { role: WorkspaceRole.Viewer, write: false, fulfill: false },
  { role: WorkspaceRole.Member, write: true, fulfill: false },
  { role: WorkspaceRole.Admin, write: true, fulfill: true },
  { role: WorkspaceRole.Owner, write: true, fulfill: true },
];

const policy = new OrdersPolicy();
const user = userActor(USER);
const as = (role: WorkspaceRole): WorkspaceMembership => ({
  workspaceId: WORKSPACE,
  userId: USER,
  role,
});
const owner = as(WorkspaceRole.Owner);

const forbidden = (action: string): unknown =>
  expect.objectContaining({ constructor: ForbiddenError, action });

describe('OrdersPolicy', () => {
  describe.each(PERM)('PERM-001 a $role', ({ role, write, fulfill }) => {
    it(write ? 'may create, edit, place and cancel orders' : 'may not write orders', () => {
      const check = (): void => {
        policy.assertCanWrite(user, as(role));
      };
      if (write) expect(check).not.toThrow();
      else expect(check).toThrow(forbidden('orders.write'));
    });

    it(fulfill ? 'may fulfill orders' : 'may not fulfill orders', () => {
      const check = (): void => {
        policy.assertCanFulfill(user, as(role));
      };
      if (fulfill) expect(check).not.toThrow();
      else expect(check).toThrow(forbidden('orders.fulfill'));
    });
  });

  it('a user outside the workspace may neither write nor fulfill', () => {
    expect(() => {
      policy.assertCanWrite(user, null);
    }).toThrow(forbidden('orders.write'));
    expect(() => {
      policy.assertCanFulfill(user, null);
    }).toThrow(forbidden('orders.fulfill'));
  });

  it('system work never writes or fulfills orders, whatever membership it carries', () => {
    const job = systemActor('consumer:orders');
    expect(() => {
      policy.assertCanWrite(job, owner);
    }).toThrow(forbidden('orders.write'));
    expect(() => {
      policy.assertCanFulfill(job, owner);
    }).toThrow(forbidden('orders.fulfill'));
  });

  describe('PAY-013 recording a payment outcome', () => {
    it('is allowed to system:consumer:orders', () => {
      expect(() => {
        policy.assertCanSettlePayment(systemActor('consumer:orders'));
      }).not.toThrow();
    });

    it.each<[string, Actor]>([
      ['another system source', systemActor('cron:orders')],
      ['a user', user],
    ])('is forbidden to %s', (_case, actor) => {
      expect(() => {
        policy.assertCanSettlePayment(actor);
      }).toThrow(forbidden('orders.settle-payment'));
    });
  });

  describe('OPS-003 maintaining the history partitions', () => {
    it('is allowed to system:job:maintain-order-event-partitions', () => {
      expect(() => {
        policy.assertCanMaintainPartitions(systemActor('job:maintain-order-event-partitions'));
      }).not.toThrow();
    });

    it.each<[string, Actor]>([
      ['another system source', systemActor('consumer:orders')],
      ['a user', user],
    ])('is forbidden to %s', (_case, actor) => {
      expect(() => {
        policy.assertCanMaintainPartitions(actor);
      }).toThrow(forbidden('orders.maintain-event-partitions'));
    });
  });
});
