import { describe, expect, it } from 'vitest';

import { bindingProblems } from './bindings';

const COMMANDS = ['payments.charge-payment', 'payments.cancel-payment'];

describe('bindingProblems', () => {
  it('accepts the queues of a service that are bound to what the map says it reads', () => {
    expect(bindingProblems('payments', [{ exchange: 'commands', routingKey: COMMANDS }])).toEqual(
      [],
    );
  });

  it('names every contract of a service that binds nothing', () => {
    expect(bindingProblems('payments', [])).toEqual([
      'payments.charge-payment: read by payments in the map, bound by no queue',
      'payments.cancel-payment: read by payments in the map, bound by no queue',
    ]);
  });

  it('names a contract of the map that no queue is bound to', () => {
    const problems = bindingProblems('payments', [
      { exchange: 'commands', routingKey: 'payments.charge-payment' },
    ]);

    expect(problems).toEqual([
      'payments.cancel-payment: read by payments in the map, bound by no queue',
    ]);
  });

  it('names a contract a queue is bound to and the map does not give to the service', () => {
    const problems = bindingProblems('payments', [
      { exchange: 'commands', routingKey: COMMANDS },
      { exchange: 'events', routingKey: ['orders.order-paid'] },
    ]);

    expect(problems).toEqual([
      'orders.order-paid: bound by a queue of payments, not in its rows of the map',
    ]);
  });

  it('names a contract bound on another exchange than the one it is published on', () => {
    const problems = bindingProblems('payments', [{ exchange: 'events', routingKey: COMMANDS }]);

    expect(problems).toEqual([
      'payments.charge-payment: bound on events, published on commands',
      'payments.cancel-payment: bound on events, published on commands',
    ]);
  });

  it('leaves an exchange of the service alone', () => {
    const problems = bindingProblems('payments', [
      { exchange: 'commands', routingKey: COMMANDS },
      { exchange: 'api.delayed', routingKey: 'api.saga-timeouts' },
    ]);

    expect(problems).toEqual([]);
  });
});
