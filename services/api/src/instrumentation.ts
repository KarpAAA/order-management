// Loaded BEFORE the application: `node --require ./dist/instrumentation.js dist/entrypoints/…`
// (docs/adr/0025, ops/observability.md §3). The instrumentations replace functions of `http`,
// `pg`, `ioredis` and `amqplib` at the moment those are required: required earlier, they stay
// as they are and nothing is traced, with no error. So this file imports OpenTelemetry and
// one file of ours that imports nothing else, and no entrypoint imports it.
import { basename } from 'node:path';

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { spanContextOf, TRACE_LINK_HEADER } from './common/tracing/trace-context';

/** One image, two processes: each is a service of its own in a trace. */
const serviceName = (): string => {
  const named = process.env.OTEL_SERVICE_NAME;
  if (named) return named;
  return basename(process.argv[1] ?? '').startsWith('main.worker') ? 'oms-worker' : 'oms-api';
};

// The Collector (docs/adr/0024). Unset or empty: nothing is sent and nothing is patched,
// which is how the tests and the stack of the system tests run.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': serviceName() }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation(),
      new NestInstrumentation(),
      // only inside a trace: the relay of the outbox asks the database, and BullMQ asks
      // Redis, several times a second with nobody waiting for the answer
      new PgInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
      new AmqplibInstrumentation({
        // a message that points at a trace instead of continuing it (a timeout of the saga)
        consumeHook: (span, { msg }) => {
          const headers = msg.properties.headers as Record<string, unknown> | undefined;
          const linked = spanContextOf(headers?.[TRACE_LINK_HEADER]);
          if (linked) span.addLink({ context: linked });
        },
      }),
    ],
  });
  sdk.start();
  // what is still in the buffer goes out before the process does
  process.once('SIGTERM', () => void sdk.shutdown());
}
