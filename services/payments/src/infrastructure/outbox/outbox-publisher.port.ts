import type { TraceCarrier } from '@infra/tracing/trace-context';

export const OUTBOX_PUBLISHER = Symbol('OUTBOX_PUBLISHER');

/** One row of the outbox, as the relay hands it over. */
export interface OutboxRecord {
  id: string;
  exchange: string;
  routingKey: string;
  /** The envelope, as it was stored. */
  payload: unknown;
  /** The trace the row was written in; none for a row written outside one. */
  traceContext?: TraceCarrier | null;
}

/**
 * Where the relay sends a message. Resolves only when the other side has taken
 * responsibility for the message; anything else is thrown, and the row stays unpublished.
 * RabbitMQ today; ROADMAP 3.8 adds Kafka as the second adapter.
 */
export interface OutboxPublisher {
  publish(record: OutboxRecord): Promise<void>;
}
