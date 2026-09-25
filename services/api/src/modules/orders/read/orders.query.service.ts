import { Inject, Injectable } from '@nestjs/common';

import { toMoneyDto } from '@common/dto/common.dto';
import { READ_DB, type ReadDb } from '@infra/database/database.tokens';
import type { Prisma } from '@infra/database/generated/prisma/client';
import {
  afterCursor,
  afterCursorAsc,
  newestFirst,
  oldestFirst,
  toCursorPage,
} from '@shared/pagination/cursor';
import type { PaginatedByCursor } from '@shared/pagination/cursor';

import { DiscountType } from '../domain/discount';
import { OrderNotFoundError } from '../domain/errors';

import type { OrderDto, OrderEventDto, OrderSummaryDto } from './dto/order.dto';
import type { OrderEventType, OrderStatus } from '../domain/order-status';

const orderSelect = {
  id: true,
  status: true,
  currency: true,
  discountType: true,
  discountValueBps: true,
  discountValueMinor: true,
  taxRateBps: true,
  subtotalMinor: true,
  discountMinor: true,
  taxMinor: true,
  totalMinor: true,
  paymentAttempt: true,
  pspChargeId: true,
  failureReason: true,
  version: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  placedAt: true,
  paidAt: true,
  fulfilledAt: true,
  cancelledAt: true,
  items: {
    select: {
      id: true,
      productId: true,
      sku: true,
      name: true,
      unitPriceMinor: true,
      quantity: true,
      lineTotalMinor: true,
    },
    orderBy: { position: 'asc' },
  },
} satisfies Prisma.OrderSelect;

const summarySelect = {
  id: true,
  status: true,
  currency: true,
  totalMinor: true,
  paymentAttempt: true,
  version: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrderSelect;

const eventSelect = {
  id: true,
  type: true,
  fromStatus: true,
  toStatus: true,
  actor: true,
  payload: true,
  createdAt: true,
} satisfies Prisma.OrderEventSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;
type SummaryRow = Prisma.OrderGetPayload<{ select: typeof summarySelect }>;
type EventRow = Prisma.OrderEventGetPayload<{ select: typeof eventSelect }>;

// Prisma enums → domain enums below are casts between identical string values.
function toOrderDto(row: OrderRow): OrderDto {
  const money = (amountMinor: bigint) => toMoneyDto(amountMinor, row.currency);
  return {
    id: row.id,
    status: row.status as OrderStatus,
    currency: row.currency,
    items: row.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      sku: item.sku,
      name: item.name,
      unitPrice: money(item.unitPriceMinor),
      quantity: item.quantity,
      lineTotal: money(item.lineTotalMinor),
    })),
    discount: {
      type: row.discountType as DiscountType,
      valueBps: row.discountValueBps,
      value: row.discountValueMinor === null ? null : money(row.discountValueMinor),
    },
    taxRateBps: row.taxRateBps,
    totals: {
      subtotal: money(row.subtotalMinor),
      discount: money(row.discountMinor),
      tax: money(row.taxMinor),
      total: money(row.totalMinor),
    },
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
  };
}

const toSummaryDto = (row: SummaryRow): OrderSummaryDto => ({
  id: row.id,
  status: row.status as OrderStatus,
  total: toMoneyDto(row.totalMinor, row.currency),
  paymentAttempt: row.paymentAttempt,
  version: row.version,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toEventDto = (row: EventRow): OrderEventDto => ({
  id: row.id,
  type: row.type as OrderEventType,
  fromStatus: row.fromStatus as OrderStatus | null,
  toStatus: row.toStatus as OrderStatus,
  actor: row.actor,
  payload: isJsonObject(row.payload) ? row.payload : {},
  createdAt: row.createdAt,
});

/** Read path. Every query is scoped to the current workspace by the database layer. */
@Injectable()
export class OrdersQueryService {
  constructor(@Inject(READ_DB) private readonly db: ReadDb) {}

  async list(filter: {
    cursor?: string;
    limit: number;
    status?: OrderStatus;
  }): Promise<PaginatedByCursor<OrderSummaryDto>> {
    const rows = await this.db.order.findMany({
      where: { ...(filter.status && { status: filter.status }), ...afterCursor(filter.cursor) },
      select: summarySelect,
      orderBy: newestFirst(),
      take: filter.limit + 1,
    });
    return toCursorPage(rows, filter.limit, toSummaryDto);
  }

  async get(orderId: string): Promise<OrderDto> {
    const row = await this.db.order.findFirst({ where: { id: orderId }, select: orderSelect });
    if (!row) throw new OrderNotFoundError(orderId);
    return toOrderDto(row);
  }

  /** History, oldest first. */
  async listEvents(
    orderId: string,
    page: { cursor?: string; limit: number },
  ): Promise<PaginatedByCursor<OrderEventDto>> {
    const exists = await this.db.order.count({ where: { id: orderId } });
    if (exists === 0) throw new OrderNotFoundError(orderId);
    const rows = await this.db.orderEvent.findMany({
      where: { orderId, ...afterCursorAsc(page.cursor) },
      select: eventSelect,
      orderBy: oldestFirst(),
      take: page.limit + 1,
    });
    return toCursorPage(rows, page.limit, toEventDto);
  }
}
