// Loaded BEFORE the application: `node --require ./dist/instrumentation.js dist/entrypoints/…`
// (docs/adr/0025, ops/observability.md §3). The instrumentations replace functions of `pg`
// and `amqplib` at the moment those are required: required earlier, they stay as they are
// and nothing is traced, with no error. So this file imports OpenTelemetry only, and no
// entrypoint imports it. A copy of the api's, with what this service uses.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';

// The Collector (docs/adr/0024). Unset or empty: nothing is sent and nothing is patched,
// which is how the tests and the stack of the system tests run.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'oms-payments',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, '')}/v1/traces` }),
    instrumentations: [
      // only inside a trace: the relay and the timers of the process ask the database
      // several times a second with nobody waiting for the answer
      new PgInstrumentation({ requireParentSpan: true }),
      new AmqplibInstrumentation(),
      // the call to the provider (`fetch`), which gets the `traceparent` of the charge
      new UndiciInstrumentation({ requireParentforSpans: true }),
    ],
  });
  sdk.start();
  // what is still in the buffer goes out before the process does
  process.once('SIGTERM', () => void sdk.shutdown());
}
