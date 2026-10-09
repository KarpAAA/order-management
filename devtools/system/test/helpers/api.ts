// The HTTP API as a client sees it: a token, JSON, and an Idempotency-Key on every POST. The
// shapes are the part of the OpenAPI document the scenarios read, written again here: the
// package depends on no service.
import { randomUUID } from 'node:crypto';

import { PASSWORD, stack, WORKSPACE_ID } from '../setup/stack';

import { eventually } from './eventually';

export interface Money {
  amountMinor: number;
  currency: string;
}

export type OrderStatus =
  'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'PAYMENT_FAILED' | 'FULFILLED' | 'CANCELLED';

export interface Order {
  id: string;
  status: OrderStatus;
  totals: { total: Money };
  paymentAttempt: number;
  pspChargeId: string | null;
  failureReason: string | null;
  version: number;
}

interface Answer {
  status: number;
  body: unknown;
}

export class ApiClient {
  private constructor(private readonly token: string) {}

  static async login(email: string): Promise<ApiClient> {
    const response = await fetch(new URL('/v1/auth/login', stack.api), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    if (response.status !== 200) {
      throw new Error(`login of ${email} answered ${response.status}: ${await response.text()}`);
    }
    const { accessToken } = (await response.json()) as { accessToken: string };
    return new ApiClient(accessToken);
  }

  /** A DRAFT order of the workspace; its id. */
  async createOrder(items: { productId: string; quantity: number }[]): Promise<string> {
    const { body } = await this.send('POST', 'orders', { items }, 201);
    return (body as { id: string }).id;
  }

  async getOrder(orderId: string): Promise<Order> {
    const { body } = await this.send('GET', `orders/${orderId}`, undefined, 200);
    return body as Order;
  }

  /** The types of the history of an order, oldest first. */
  async history(orderId: string): Promise<string[]> {
    const { body } = await this.send('GET', `orders/${orderId}/events?limit=100`, undefined, 200);
    return (body as { items: { type: string }[] }).items.map((event) => event.type);
  }

  /** Places the order as it is now: 202, and the saga of a new payment attempt begins. */
  async place(orderId: string): Promise<void> {
    const { version } = await this.getOrder(orderId);
    await this.send('POST', `orders/${orderId}/place`, { version }, 202);
  }

  /** 204: cancelled. 202: asked for, the charge that is under way decides. */
  async cancel(orderId: string): Promise<number> {
    const { version } = await this.getOrder(orderId);
    const { status } = await this.send('POST', `orders/${orderId}/cancel`, { version });
    return status;
  }

  /** The order once its payment attempt has an outcome the client can see. */
  untilSettled(orderId: string, attempt: number): Promise<Order> {
    return eventually(
      () => this.getOrder(orderId),
      (order) => order.paymentAttempt === attempt && order.status !== 'PENDING_PAYMENT',
      { what: `attempt ${attempt} of order ${orderId} to leave PENDING_PAYMENT` },
    );
  }

  /** Until the history of the order has an entry of the type. */
  untilRecorded(orderId: string, type: string): Promise<string[]> {
    return eventually(
      () => this.history(orderId),
      (types) => types.includes(type),
      { what: `${type} in the history of order ${orderId}` },
    );
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    expected?: number,
  ): Promise<Answer> {
    const response = await fetch(new URL(`/v1/workspaces/${WORKSPACE_ID}/${path}`, stack.api), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(method === 'POST' && {
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (expected !== undefined && response.status !== expected) {
      throw new Error(`${method} ${path} answered ${response.status}, not ${expected}: ${text}`);
    }
    return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
  }
}
