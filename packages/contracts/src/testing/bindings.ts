import { consumedBy } from '../parties';
import { exchanges } from '../topology';

import type { Service } from '../parties';

/** What a consumer asks of the broker: the `exchange` and `routingKey` of a `@RabbitSubscribe`. */
export interface Binding {
  exchange: string;
  routingKey: string | readonly string[];
}

const SHARED: readonly string[] = Object.values(exchanges).map((exchange) => exchange.name);

/**
 * What the queues of a service are bound to, against its rows in the map of parties; empty =
 * they agree. A name that is bound and not in the map is a message the service takes and
 * nobody knows it does; a name of the map that is not bound never arrives. An exchange of
 * the service's own (the delayed messages of the api) is not a matter of the contracts.
 */
export const bindingProblems = (service: Service, bindings: readonly Binding[]): string[] => {
  const expected = new Map<string, string>(
    consumedBy(service).map((party) => [party.contract.name, exchanges[party.exchange].name]),
  );
  const bound = new Map<string, string>();
  for (const binding of bindings) {
    if (!SHARED.includes(binding.exchange)) continue;
    for (const name of [binding.routingKey].flat()) bound.set(name, binding.exchange);
  }

  const problems: string[] = [];
  for (const [name, exchange] of expected) {
    const actual = bound.get(name);
    if (actual === undefined)
      problems.push(`${name}: read by ${service} in the map, bound by no queue`);
    else if (actual !== exchange)
      problems.push(`${name}: bound on ${actual}, published on ${exchange}`);
  }
  for (const name of bound.keys()) {
    if (!expected.has(name))
      problems.push(`${name}: bound by a queue of ${service}, not in its rows of the map`);
  }
  return problems;
};
