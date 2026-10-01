import { Injectable } from '@nestjs/common';

import type { Actor } from '@shared/auth/actor';
import { hasAnyRole, WorkspaceRole } from '@shared/auth/workspace-role';
import type { WorkspaceMembership } from '@shared/auth/workspace-role';
import { ForbiddenError } from '@shared/errors/forbidden-error';

const ORDER_WRITERS = [WorkspaceRole.Owner, WorkspaceRole.Admin, WorkspaceRole.Member] as const;
const ORDER_FULFILLERS = [WorkspaceRole.Owner, WorkspaceRole.Admin] as const;
const PAYMENT_SETTLER_SOURCE = 'consumer:orders';
const PARTITION_MAINTAINER_SOURCE = 'job:maintain-order-event-partitions';

/**
 * Who may do what to an order (docs/requirements.md → Permissions). Reading needs only
 * membership, which the workspace access guard already verified (404 otherwise).
 * The state machine ("may this order move?") is the domain's job, checked after this.
 */
@Injectable()
export class OrdersPolicy {
  /** Create, edit, place, cancel: MEMBER and above. */
  assertCanWrite(actor: Actor, membership: WorkspaceMembership | null): void {
    if (actor.kind === 'user' && hasAnyRole(membership, ORDER_WRITERS)) return;
    throw new ForbiddenError('orders.write');
  }

  assertCanFulfill(actor: Actor, membership: WorkspaceMembership | null): void {
    if (actor.kind === 'user' && hasAnyRole(membership, ORDER_FULFILLERS)) return;
    throw new ForbiddenError('orders.fulfill');
  }

  /** Recording a payment outcome is the orders queue consumer's job, nobody else's. */
  assertCanSettlePayment(actor: Actor): void {
    if (actor.kind === 'system' && actor.source === PAYMENT_SETTLER_SOURCE) return;
    throw new ForbiddenError('orders.settle-payment');
  }

  /** Creating and dropping history partitions is the maintenance job's work, nobody else's. */
  assertCanMaintainPartitions(actor: Actor): void {
    if (actor.kind === 'system' && actor.source === PARTITION_MAINTAINER_SOURCE) return;
    throw new ForbiddenError('orders.maintain-event-partitions');
  }
}
