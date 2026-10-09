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
import { OrderPaymentFailedV1 } from './orders/order-payment-failed.v1';
import { OrderPlacedV1 } from './orders/order-placed.v1';
import { OrderReturnedToDraftV1 } from './orders/order-returned-to-draft.v1';
import { CancelPaymentV1 } from './payments/cancel-payment.v1';
import { ChargePaymentV1 } from './payments/charge-payment.v1';
import { PaymentCancelledV1 } from './payments/payment-cancelled.v1';
import { PaymentFailedV1 } from './payments/payment-failed.v1';
import { PaymentSucceededV1 } from './payments/payment-succeeded.v1';
import { contractKey } from './registry';

import type { Contract } from './registry';
import type { exchanges } from './topology';

export const services = ['api', 'payments', 'inventory', 'notifications'] as const;
export type Service = (typeof services)[number];

type Exchange = keyof typeof exchanges;

/** Who writes a contract and who reads it, and on which exchange it travels. */
export interface Party<C extends { name: string; version: number } = Contract> {
  contract: C;
  exchange: Exchange;
  /** Empty: no service sends it (an operator does), or no build writes this version any more. */
  producers: readonly Service[];
  /** Empty for an event nobody listens to yet. */
  consumers: readonly Service[];
}

const command = (contract: Contract, producers: Service[], consumer: Service): Party => ({
  contract,
  exchange: 'commands',
  producers,
  consumers: [consumer],
});

const event = (contract: Contract, producer: Service, consumers: Service[]): Party => ({
  contract,
  exchange: 'events',
  producers: [producer],
  consumers,
});

/**
 * Every contract of the system, with its two sides (docs/adr/0021-contract-testing.md). The
 * contract test of a service holds the service to its rows: what it binds, what it handles,
 * what it writes. A new routing key in a consumer, or a new `create()` in an adapter, is a
 * change of a row here.
 *
 * A version that replaces another gets its readers first: a row may name a consumer before
 * it names a producer, never the other way round (`partyProblems`).
 */
export const parties: readonly Party[] = [
  command(ChargePaymentV1, ['api'], 'payments'),
  command(CancelPaymentV1, ['api'], 'payments'),
  event(PaymentSucceededV1, 'payments', ['api']),
  event(PaymentFailedV1, 'payments', ['api']),
  event(PaymentCancelledV1, 'payments', ['api']),

  command(ReserveStockV1, ['api'], 'inventory'),
  command(ReleaseStockV1, ['api'], 'inventory'),
  // sent by an operator, not by a service
  command(AdjustStockV1, [], 'inventory'),
  event(StockReservedV1, 'inventory', ['api']),
  event(StockReservationFailedV1, 'inventory', ['api']),
  event(StockReleasedV1, 'inventory', ['api']),
  event(StockAdjustedV1, 'inventory', []),

  event(OrderPlacedV1, 'api', ['notifications']),
  event(OrderPaidV1, 'api', ['notifications']),
  event(OrderCancelledV1, 'api', ['notifications']),
  event(OrderFulfilledV1, 'api', ['notifications']),
  event(OrderPaymentFailedV1, 'api', ['notifications']),
  event(OrderReturnedToDraftV1, 'api', ['notifications']),
];

export const producedBy = (service: Service): Party[] =>
  parties.filter((party) => party.producers.includes(service));

export const consumedBy = (service: Service): Party[] =>
  parties.filter((party) => party.consumers.includes(service));

/** The service a name belongs to: `orders` is a module of the api, the others are services. */
const OWNERS: Record<string, Service> = {
  orders: 'api',
  payments: 'payments',
  inventory: 'inventory',
};

interface Named {
  name: string;
  version: number;
}

const keyOf = ({ name, version }: Named): string => contractKey(name, version);

/**
 * What is wrong with a map of parties; empty = nothing. Three rules:
 * - every contract has one row, and every row a contract;
 * - a command is read by the service it is named after and by nobody else; an event is
 *   written by the service it is named after and by nobody else;
 * - a service that reads one version of a name reads every version somebody writes.
 */
export const partyProblems = (map: readonly Party<Named>[], known: readonly Named[]): string[] => {
  const problems: string[] = [];

  const rows = map.map((party) => keyOf(party.contract));
  const contractKeys = known.map(keyOf);
  for (const key of contractKeys) {
    const count = rows.filter((row) => row === key).length;
    if (count === 0) problems.push(`${key}: has no row in the map of parties`);
    if (count > 1) problems.push(`${key}: has ${count} rows in the map of parties`);
  }
  for (const row of new Set(rows)) {
    if (!contractKeys.includes(row)) problems.push(`${row}: is not a contract of the registry`);
  }

  for (const party of map) {
    const key = keyOf(party.contract);
    const owner = OWNERS[party.contract.name.split('.')[0] ?? ''];
    if (owner === undefined) {
      problems.push(`${key}: is named after no service`);
    } else if (party.exchange === 'commands') {
      if (party.consumers.length !== 1 || party.consumers[0] !== owner) {
        problems.push(`${key}: a command is read by ${owner}, its receiver, and nobody else`);
      }
    } else if (party.producers.some((producer) => producer !== owner)) {
      problems.push(`${key}: an event is written by ${owner}, its publisher, and nobody else`);
    }
  }

  for (const name of new Set(map.map((party) => party.contract.name))) {
    const versions = map.filter((party) => party.contract.name === name);
    const readers = new Set(versions.flatMap((party) => party.consumers));
    for (const party of versions.filter((version) => version.producers.length > 0)) {
      for (const reader of readers) {
        if (party.consumers.includes(reader)) continue;
        const reads = versions
          .filter((version) => version.consumers.includes(reader))
          .map((version) => `@${version.contract.version}`);
        problems.push(
          `${keyOf(party.contract)}: written by ${party.producers.join(', ')}, ` +
            `but ${reader} reads ${reads.join(', ')} only`,
        );
      }
    }
  }

  return problems;
};
