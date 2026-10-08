import { Factory } from 'fishery';

import { NO_DISCOUNT } from '@modules/orders/domain/discount';
import type { Discount } from '@modules/orders/domain/discount';
import { OrderProductNotFoundError } from '@modules/orders/domain/errors';
import { Order } from '@modules/orders/domain/order';
import type { OrderLineInput } from '@modules/orders/domain/order';
import { OrderSaga } from '@modules/orders/domain/order-saga';
import { OrderSagaStep } from '@modules/orders/domain/order-saga-step';
import { OrderStatus } from '@modules/orders/domain/order-status';
import { OrderSagaMapper } from '@modules/orders/infrastructure/order-saga.mapper';
import { OrderMapper } from '@modules/orders/infrastructure/order.mapper';

import {
  PRODUCT_ACME_ACTIVE,
  PRODUCT_GLOBEX_ACTIVE,
  USER_ACME_MEMBER,
  USER_GLOBEX_MEMBER,
  WS_ACME,
  WS_GLOBEX,
} from '../seed/ids';
import { testDb } from '../setup/db';

/** What a test asks for. The order itself is built by the domain, never by hand. */
export interface OrderSpec {
  workspaceId: string;
  /** The enum or its string value — e2e specs do not import the domain. */
  status: OrderStatus | `${OrderStatus}`;
  /** null → one unit of the workspace's seeded ACTIVE product */
  lines: { productId: string; quantity: number }[] | null;
  discount: Discount;
  /** null → the workspace's seeded MEMBER */
  createdBy: string | null;
  /**
   * Where the saga of the last placing stands. null → what the status implies: a
   * PENDING_PAYMENT order waits for its charge (CHARGING), a paid one is COMPLETED, a failed
   * one ABORTED. An order that was never placed has no saga.
   */
  sagaStep: OrderSagaStep | `${OrderSagaStep}` | null;
}

const SEEDED_DEFAULTS: Record<string, { productId: string; createdBy: string }> = {
  [WS_ACME]: { productId: PRODUCT_ACME_ACTIVE, createdBy: USER_ACME_MEMBER },
  [WS_GLOBEX]: { productId: PRODUCT_GLOBEX_ACTIVE, createdBy: USER_GLOBEX_MEMBER },
};

/** The domain methods that lead from DRAFT to each status, in order. */
const PATH: Record<OrderStatus, readonly ((order: Order, at: Date, by: string) => void)[]> = {
  [OrderStatus.Draft]: [],
  [OrderStatus.PendingPayment]: [place],
  [OrderStatus.Paid]: [place, pay],
  [OrderStatus.PaymentFailed]: [place, decline],
  [OrderStatus.Fulfilled]: [place, pay, fulfill],
  [OrderStatus.Cancelled]: [cancel],
};

/** The step of the saga a status implies when the test does not ask for another. */
const SAGA_STEP: Partial<Record<OrderStatus, OrderSagaStep>> = {
  [OrderStatus.PendingPayment]: OrderSagaStep.Charging,
  [OrderStatus.Paid]: OrderSagaStep.Completed,
  [OrderStatus.Fulfilled]: OrderSagaStep.Completed,
  [OrderStatus.PaymentFailed]: OrderSagaStep.Aborted,
};
const ENDED: readonly OrderSagaStep[] = [OrderSagaStep.Completed, OrderSagaStep.Aborted];
/** Far enough: no test waits for the timeout of a saga the factory wrote. */
const SAGA_DEADLINE_MS = 3_600_000;

const PSP_ACTOR = 'system:consumer:orders';

function place(order: Order, now: Date, by: string): void {
  order.place({ now, changedBy: by });
}
function pay(order: Order, now: Date): void {
  const attempt = order.paymentAttempt;
  order.markPaid({ now, changedBy: PSP_ACTOR, attempt, pspChargeId: `ch_test_${order.id}` });
}
function decline(order: Order, now: Date): void {
  const attempt = order.paymentAttempt;
  order.markPaymentFailed({ now, changedBy: PSP_ACTOR, attempt, reason: 'card_declined' });
}
function fulfill(order: Order, now: Date, by: string): void {
  order.fulfill({ now, changedBy: by });
}
function cancel(order: Order, now: Date, by: string): void {
  order.cancel({ now, changedBy: by });
}

/**
 * An order in any status, reached the way the app reaches it: `Order.draft` with catalog
 * data read from the database, then the real transitions, then the repository's rows
 * (`OrderMapper`). Totals, timestamps and history are therefore always consistent.
 *
 * An order that was placed gets the saga of that placing (`sagaStep`), without the commands
 * and the timeout the app would have written: the test is the other side of the broker.
 *
 * Known shortcut: `version` stays 0 whatever the status (the app increments it per save).
 *
 *   await orderFactory.create({ status: OrderStatus.Paid });
 *   await orderFactory.create({ workspaceId: WS_GLOBEX, lines: [{ productId, quantity: 3 }] });
 */
export const orderFactory = Factory.define<OrderSpec, unknown, Order>(({ onCreate }) => {
  onCreate(async (spec) => {
    const db = testDb();
    const defaults = SEEDED_DEFAULTS[spec.workspaceId];
    const createdBy = spec.createdBy ?? defaults?.createdBy;
    const requested =
      spec.lines ?? (defaults ? [{ productId: defaults.productId, quantity: 1 }] : null);
    if (!createdBy || !requested) {
      throw new Error('orderFactory: pass { createdBy, lines } for a non-seeded workspace');
    }

    // Workspace terms and catalog snapshots, as OrderInputsReader reads them in the app.
    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: spec.workspaceId } });
    const products = await db.product.findMany({
      where: { workspaceId: spec.workspaceId, id: { in: requested.map((l) => l.productId) } },
    });
    const lines: OrderLineInput[] = requested.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      // another workspace's product is "not found", exactly as through the scoped client
      if (!product) throw new OrderProductNotFoundError(item.productId);
      return {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        unitPriceMinor: product.priceMinor,
        isActive: product.status === 'ACTIVE',
        quantity: item.quantity,
      };
    });

    // History entries 1 s apart, ending a second in the PAST: whatever the test does next
    // through the API is stamped later and sorts after the factory's history.
    let now = Date.now() - (PATH[spec.status as OrderStatus].length + 1) * 1000;
    const tick = (): Date => new Date((now += 1000));
    const order = Order.draft({
      workspaceId: spec.workspaceId,
      currency: workspace.currency,
      taxRateBps: workspace.taxRateBps,
      lines,
      discount: spec.discount,
      createdBy,
      now: new Date(now),
    });
    for (const step of PATH[spec.status as OrderStatus]) step(order, tick(), createdBy);

    // The same rows OrdersRepository.insert writes.
    await db.order.create({ data: OrderMapper.toCreate(order) });
    await db.orderItem.createMany({ data: OrderMapper.toItemRows(order) });
    await db.orderEvent.createMany({ data: OrderMapper.toEventRows(order, order.pullHistory()) });

    const step = (spec.sagaStep ?? SAGA_STEP[spec.status as OrderStatus]) as
      OrderSagaStep | undefined;
    if (step !== undefined && order.paymentAttempt > 0) {
      const at = new Date(now);
      const saga = OrderSaga.restore({
        workspaceId: order.workspaceId,
        orderId: order.id,
        attempt: order.paymentAttempt,
        step,
        deadlineAt: ENDED.includes(step) ? null : new Date(now + SAGA_DEADLINE_MS),
        cancelRequestedAt: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      });
      await db.orderSaga.create({ data: OrderSagaMapper.toCreate(saga) });
    }
    return order;
  });

  return {
    workspaceId: WS_ACME,
    status: OrderStatus.Draft,
    lines: null,
    discount: NO_DISCOUNT,
    createdBy: null,
    sagaStep: null,
  };
});
