import { secondsSince, type Metrics } from '@shared/observability/metrics';

/**
 * What the entry of the broker counts (docs/adr/0027): every delivery with how it ended and
 * how long its handler took, and what became of a failed one. The queue is the only label:
 * a routing key is a contract name today and anything tomorrow.
 */
export interface BrokerMeters {
  delivered(queue: string, outcome: 'ok' | 'failed', startedAt: number): void;
  /** Rejected to the wait queue: it comes again. */
  retried(queue: string): void;
  /** Given up: in `<queue>.dlq`, for somebody to look at. */
  parked(queue: string): void;
}

export function brokerMeters(metrics: Metrics): BrokerMeters {
  const duration = metrics.histogram({
    name: 'broker_message_duration_seconds',
    help: 'Time a handler took with one delivery of a broker message.',
    labels: ['queue', 'outcome'],
  });
  const retried = metrics.counter({
    name: 'broker_messages_retried_total',
    help: 'Deliveries that failed and were sent to the wait queue.',
    labels: ['queue'],
  });
  const parked = metrics.counter({
    name: 'broker_messages_parked_total',
    help: 'Messages given up and moved to the dead-letter queue.',
    labels: ['queue'],
  });
  return {
    delivered: (queue, outcome, startedAt) => {
      duration.observe({ queue, outcome }, secondsSince(startedAt));
    },
    retried: (queue) => {
      retried.inc({ queue });
    },
    parked: (queue) => {
      parked.inc({ queue });
    },
  };
}
