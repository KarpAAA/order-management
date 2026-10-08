import type { Prisma } from '@infra/database/generated/prisma/client';

import { OrderSaga } from '../domain/order-saga';

import type { OrderSagaStep } from '../domain/order-saga-step';

export const orderSagaSelect = {
  workspaceId: true,
  orderId: true,
  attempt: true,
  step: true,
  deadlineAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrderSagaSelect;

type OrderSagaRow = Prisma.OrderSagaGetPayload<{ select: typeof orderSagaSelect }>;

/** Columns of `order_sagas` except keys and version. */
function columns(saga: OrderSaga) {
  const s = saga.snapshot();
  return {
    step: s.step,
    deadlineAt: s.deadlineAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Domain ↔ persistence. Stateless; `toDomain` restores, it never re-validates. */
export const OrderSagaMapper = {
  toDomain(row: OrderSagaRow): OrderSaga {
    return OrderSaga.restore({
      workspaceId: row.workspaceId,
      orderId: row.orderId,
      attempt: row.attempt,
      step: row.step as OrderSagaStep, // Prisma enum → domain enum, identical values
      deadlineAt: row.deadlineAt,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  },

  toCreate(saga: OrderSaga): Prisma.OrderSagaUncheckedCreateInput {
    return {
      workspaceId: saga.workspaceId,
      orderId: saga.orderId,
      attempt: saga.attempt,
      version: saga.version,
      ...columns(saga),
    };
  },

  /** Everything but keys and version: the repository increments the version itself. */
  toUpdate(saga: OrderSaga): Prisma.OrderSagaUncheckedUpdateManyInput {
    return columns(saga);
  },
};
