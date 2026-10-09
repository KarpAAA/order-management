import type { Prisma } from '@infra/database/generated/prisma/client';
import { Money } from '@shared/domain/money';

import { DiscountType } from '../domain/discount';
import { Order } from '../domain/order';
import { OrderLine } from '../domain/order-line';

import type { Discount } from '../domain/discount';
import type { OrderHistoryEntry } from '../domain/order';
import type { OrderStatus } from '../domain/order-status';

export const orderWithItemsInclude = {
  items: {
    select: {
      id: true,
      position: true,
      productId: true,
      sku: true,
      name: true,
      unitPriceMinor: true,
      quantity: true,
    },
    orderBy: { position: 'asc' },
  },
} satisfies Prisma.OrderInclude;

type OrderRowWithItems = Prisma.OrderGetPayload<{ include: typeof orderWithItemsInclude }>;

function toDiscount(row: OrderRowWithItems): Discount {
  switch (row.discountType) {
    case 'PERCENT':
      return { type: DiscountType.Percent, valueBps: row.discountValueBps ?? 0 };
    case 'FIXED':
      return { type: DiscountType.Fixed, valueMinor: row.discountValueMinor ?? 0n };
    case 'NONE':
      return { type: DiscountType.None };
  }
}

function discountColumns(discount: Discount) {
  return {
    discountType: discount.type,
    discountValueBps: discount.type === DiscountType.Percent ? discount.valueBps : null,
    discountValueMinor: discount.type === DiscountType.Fixed ? discount.valueMinor : null,
  };
}

/** Columns of `orders` except keys and version; totals are stored for reads and CHECKs. */
function columns(order: Order) {
  const s = order.snapshot();
  const totals = order.totals;
  return {
    status: s.status,
    currency: s.currency,
    ...discountColumns(s.discount),
    taxRateBps: s.taxRateBps,
    subtotalMinor: totals.subtotal.amountMinor,
    discountMinor: totals.discount.amountMinor,
    taxMinor: totals.tax.amountMinor,
    totalMinor: totals.total.amountMinor,
    paymentAttempt: s.paymentAttempt,
    pspChargeId: s.pspChargeId,
    failureReason: s.failureReason,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    placedAt: s.placedAt,
    paidAt: s.paidAt,
    fulfilledAt: s.fulfilledAt,
    cancelledAt: s.cancelledAt,
  };
}

/** Domain ↔ persistence. Stateless; `toDomain` restores, it never re-validates. */
export const OrderMapper = {
  toDomain(row: OrderRowWithItems): Order {
    return Order.restore({
      workspaceId: row.workspaceId,
      id: row.id,
      status: row.status as OrderStatus, // Prisma enum → domain enum, identical values
      currency: row.currency,
      discount: toDiscount(row),
      taxRateBps: row.taxRateBps,
      lines: row.items.map((item) =>
        OrderLine.restore({
          id: item.id,
          position: item.position,
          productId: item.productId,
          sku: item.sku,
          name: item.name,
          unitPrice: Money.of(item.unitPriceMinor, row.currency),
          quantity: item.quantity,
        }),
      ),
      paymentAttempt: row.paymentAttempt,
      pspChargeId: row.pspChargeId,
      failureReason: row.failureReason,
      version: row.version,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      placedAt: row.placedAt,
      paidAt: row.paidAt,
      fulfilledAt: row.fulfilledAt,
      cancelledAt: row.cancelledAt,
    });
  },

  toCreate(order: Order): Prisma.OrderUncheckedCreateInput {
    return {
      workspaceId: order.workspaceId,
      id: order.id,
      version: order.version,
      ...columns(order),
    };
  },

  /** Everything but keys and version: the repository increments the version itself. */
  toUpdate(order: Order): Prisma.OrderUncheckedUpdateManyInput {
    return columns(order);
  },

  toItemRows(order: Order): Prisma.OrderItemCreateManyInput[] {
    return order.lines.map((line) => {
      const l = line.snapshot();
      return {
        workspaceId: order.workspaceId,
        id: l.id,
        orderId: order.id,
        position: l.position,
        productId: l.productId,
        sku: l.sku,
        name: l.name,
        unitPriceMinor: l.unitPrice.amountMinor,
        quantity: l.quantity,
        lineTotalMinor: line.total.amountMinor,
      };
    });
  },

  toEventRows(
    order: Order,
    history: readonly OrderHistoryEntry[],
  ): Prisma.OrderEventCreateManyInput[] {
    return history.map((entry) => ({
      workspaceId: order.workspaceId,
      id: entry.id,
      orderId: order.id,
      type: entry.type,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      actor: entry.changedBy,
      // plain JSON by construction: strings, numbers and the shortages of a reservation
      payload: entry.payload as Prisma.InputJsonObject,
      createdAt: entry.at,
    }));
  },
};
