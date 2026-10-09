/**
 * Where a message is published. The address is part of the contract: a producer and a consumer
 * that disagree on it lose every message without an error.
 *
 * - `commands`: a direct exchange. The receiver binds its own queue with the command's `name`.
 * - `events`: a topic exchange. Every subscriber binds its own queue with the names it reads.
 *
 * The routing key of a message is always its `name`. Queues are not listed here: a queue
 * belongs to the service that reads it.
 */
export const exchanges = {
  commands: { name: 'commands', type: 'direct' },
  events: { name: 'events', type: 'topic' },
} as const;
