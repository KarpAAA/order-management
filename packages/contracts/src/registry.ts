import { z } from 'zod';

import { AdjustStockV1 } from './inventory/adjust-stock.v1';
import { ReleaseStockV1 } from './inventory/release-stock.v1';
import { ReserveStockV1 } from './inventory/reserve-stock.v1';
import { StockAdjustedV1 } from './inventory/stock-adjusted.v1';
import { StockReleasedV1 } from './inventory/stock-released.v1';
import { StockReservationFailedV1 } from './inventory/stock-reservation-failed.v1';
import { StockReservedV1 } from './inventory/stock-reserved.v1';
import { OrderCancelledV1 } from './orders/order-cancelled.v1';
import { OrderFulfilledV1 } from './orders/order-fulfilled.v1';
import { OrderPaidV1 } from './orders/order-paid.v1';
import { OrderPlacedV1 } from './orders/order-placed.v1';
import { ChargePaymentV1 } from './payments/charge-payment.v1';
import { PaymentFailedV1 } from './payments/payment-failed.v1';
import { PaymentSucceededV1 } from './payments/payment-succeeded.v1';

/** Every contract of the system. A new `*.v<N>.ts` is added here, or no consumer can read it. */
export const contracts = [
  ChargePaymentV1,
  PaymentSucceededV1,
  PaymentFailedV1,
  OrderPlacedV1,
  OrderPaidV1,
  OrderCancelledV1,
  OrderFulfilledV1,
  ReserveStockV1,
  ReleaseStockV1,
  AdjustStockV1,
  StockReservedV1,
  StockReservationFailedV1,
  StockReleasedV1,
  StockAdjustedV1,
] as const;

export type Contract = (typeof contracts)[number];
export type AnyMessage = z.infer<Contract['schema']>;

export const contractKey = (name: string, version: number): string => `${name}@${version}`;

const byKey = new Map<string, Contract>(contracts.map((c) => [contractKey(c.name, c.version), c]));

const header = z.object({ name: z.string(), version: z.number() });

export type ParseFailure =
  /** Not a message at all: no `name` or `version`. */
  | 'malformed'
  /** A contract this build does not know: a newer sender, or a retired version. */
  | 'unknown'
  /** A known contract whose content does not match its schema. */
  | 'invalid';

export type ParseResult =
  { ok: true; message: AnyMessage } | { ok: false; reason: ParseFailure; detail: string };

/**
 * The entry of every consumer: picks the schema by `name` + `version` and validates.
 * Never throws: what to do with a bad message (reject, dead-letter) is the consumer's decision.
 */
export const parseMessage = (raw: unknown): ParseResult => {
  const head = header.safeParse(raw);
  if (!head.success) {
    return { ok: false, reason: 'malformed', detail: z.prettifyError(head.error) };
  }

  const key = contractKey(head.data.name, head.data.version);
  const contract = byKey.get(key);
  if (!contract) return { ok: false, reason: 'unknown', detail: key };

  const parsed = contract.schema.safeParse(raw);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, reason: 'invalid', detail: z.prettifyError(parsed.error) };
};
