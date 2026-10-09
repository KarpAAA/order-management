import { describe, expect, it } from 'vitest';

import { consumedBy, parties, partyProblems, producedBy, services } from './parties';
import { contractKey, contracts } from './registry';

import type { Party, Service } from './parties';

type Row = Party<{ name: string; version: number }>;

const row = (
  key: string,
  exchange: Row['exchange'],
  producers: Service[],
  consumers: Service[],
): Row => {
  const [name = '', version = '1'] = key.split('@');
  return { contract: { name, version: Number(version) }, exchange, producers, consumers };
};

const problemsOf = (map: Row[]): string[] =>
  partyProblems(
    map,
    map.map((party) => party.contract),
  );

const keysOf = (rows: readonly Party[]): string[] =>
  rows.map((party) => contractKey(party.contract.name, party.contract.version));

describe('the map of parties', () => {
  it('CTR-010 CTR-011 CTR-012 has nothing wrong with it', () => {
    expect(partyProblems(parties, contracts)).toEqual([]);
  });

  it('gives every service the contracts it writes and the ones it reads', () => {
    const written = Object.fromEntries(services.map((s) => [s, keysOf(producedBy(s))]));
    const read = Object.fromEntries(services.map((s) => [s, keysOf(consumedBy(s))]));

    expect(written).toEqual({
      api: [
        'payments.charge-payment@1',
        'payments.cancel-payment@1',
        'inventory.reserve-stock@1',
        'inventory.release-stock@1',
        'orders.order-placed@1',
        'orders.order-paid@1',
        'orders.order-cancelled@1',
        'orders.order-fulfilled@1',
        'orders.order-payment-failed@1',
        'orders.order-returned-to-draft@1',
      ],
      payments: [
        'payments.payment-succeeded@1',
        'payments.payment-failed@1',
        'payments.payment-cancelled@1',
      ],
      inventory: [
        'inventory.stock-reserved@1',
        'inventory.stock-reservation-failed@1',
        'inventory.stock-released@1',
        'inventory.stock-adjusted@1',
      ],
      notifications: [],
    });
    expect(read).toEqual({
      api: [
        'payments.payment-succeeded@1',
        'payments.payment-failed@1',
        'payments.payment-cancelled@1',
        'inventory.stock-reserved@1',
        'inventory.stock-reservation-failed@1',
        'inventory.stock-released@1',
      ],
      payments: ['payments.charge-payment@1', 'payments.cancel-payment@1'],
      inventory: [
        'inventory.reserve-stock@1',
        'inventory.release-stock@1',
        'inventory.adjust-stock@1',
      ],
      notifications: [
        'orders.order-placed@1',
        'orders.order-paid@1',
        'orders.order-cancelled@1',
        'orders.order-fulfilled@1',
        'orders.order-payment-failed@1',
        'orders.order-returned-to-draft@1',
      ],
    });
  });
});

describe('partyProblems', () => {
  const paid = row('orders.order-paid@1', 'events', ['api'], ['notifications']);
  const charge = row('payments.charge-payment@1', 'commands', ['api'], ['payments']);

  it('CTR-010 names a contract with no row', () => {
    expect(partyProblems([paid], [paid.contract, charge.contract])).toEqual([
      'payments.charge-payment@1: has no row in the map of parties',
    ]);
  });

  it('CTR-010 names a contract with two rows', () => {
    expect(partyProblems([paid, paid], [paid.contract])).toEqual([
      'orders.order-paid@1: has 2 rows in the map of parties',
    ]);
  });

  it('CTR-010 names a row with no contract', () => {
    expect(partyProblems([paid, charge], [paid.contract])).toEqual([
      'payments.charge-payment@1: is not a contract of the registry',
    ]);
  });

  it.each([
    ['read by another service', row('payments.charge-payment@1', 'commands', ['api'], ['api'])],
    [
      'read by two services',
      row('payments.charge-payment@1', 'commands', ['api'], ['payments', 'inventory']),
    ],
    ['read by nobody', row('payments.charge-payment@1', 'commands', ['api'], [])],
  ])('CTR-011 refuses a command %s', (_case, party) => {
    expect(problemsOf([party])).toEqual([
      'payments.charge-payment@1: a command is read by payments, its receiver, and nobody else',
    ]);
  });

  it('CTR-011 accepts a command no service sends', () => {
    expect(problemsOf([row('inventory.adjust-stock@1', 'commands', [], ['inventory'])])).toEqual(
      [],
    );
  });

  it('CTR-011 refuses an event written by another service', () => {
    expect(problemsOf([row('orders.order-paid@1', 'events', ['payments'], [])])).toEqual([
      'orders.order-paid@1: an event is written by api, its publisher, and nobody else',
    ]);
  });

  it('CTR-011 accepts an event nobody reads', () => {
    expect(problemsOf([row('inventory.stock-adjusted@1', 'events', ['inventory'], [])])).toEqual(
      [],
    );
  });

  it('CTR-011 refuses a name that belongs to no service', () => {
    expect(problemsOf([row('billing.invoice-sent@1', 'events', ['api'], [])])).toEqual([
      'billing.invoice-sent@1: is named after no service',
    ]);
  });

  describe('CTR-012 a new version of a contract', () => {
    it('is refused while its publisher writes it and a reader of the old one does not read it', () => {
      const next = row('orders.order-paid@2', 'events', ['api'], []);

      expect(problemsOf([paid, next])).toEqual([
        'orders.order-paid@2: written by api, but notifications reads @1 only',
      ]);
    });

    it('is accepted with its readers and no publisher yet: the first deploy', () => {
      const next = row('orders.order-paid@2', 'events', [], ['notifications']);

      expect(problemsOf([paid, next])).toEqual([]);
    });

    it('is accepted when the publisher has moved to it: the second deploy', () => {
      const old = row('orders.order-paid@1', 'events', [], ['notifications']);
      const next = row('orders.order-paid@2', 'events', ['api'], ['notifications']);

      expect(problemsOf([old, next])).toEqual([]);
    });

    it('is accepted when the old one has no reader left: the third deploy', () => {
      const old = row('orders.order-paid@1', 'events', [], []);
      const next = row('orders.order-paid@2', 'events', ['api'], ['notifications']);

      expect(problemsOf([old, next])).toEqual([]);
    });

    it('is refused when a reader drops the old one while it is still written', () => {
      const next = row('orders.order-paid@2', 'events', [], ['notifications']);
      const old = row('orders.order-paid@1', 'events', ['api'], []);

      expect(problemsOf([old, next])).toEqual([
        'orders.order-paid@1: written by api, but notifications reads @2 only',
      ]);
    });
  });
});
