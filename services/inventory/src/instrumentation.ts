// Loaded BEFORE the application: `node --require ./dist/instrumentation.js dist/entrypoints/…`
// (docs/adr/0025, ops/observability.md §3). The instrumentations replace functions of `pg`
// and `amqplib` at the moment those are required: required earlier, they stay as they are
// and nothing is traced, with no error. So this file imports OpenTelemetry only, and no
// entrypoint imports it. A copy of the api's, with what this service uses.
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { NodeSDK } from '@opentelemetry/sdk-node';

// The Collector (docs/adr/0024). Unset or empty: nothing is sent and nothing is patched,
// which is how the tests and the stack of the system tests run.
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
// The log lines too (docs/adr/0026): only for a process that is not a container, where no
// agent reads its stdout. In a container the agent has the line, and this would be a second.
const sendLogs = process.env.OTEL_LOGS_EXPORTER === 'otlp';

if (endpoint) {
  const collector = endpoint.replace(/\/$/, '');
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'oms-inventory',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${collector}/v1/traces` }),
    // always given: left out, the SDK reads OTEL_LOGS_EXPORTER itself and its default sends
    logRecordProcessors: sendLogs
      ? [
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({ url: `${collector}/v1/logs` }),
          }),
        ]
      : [],
    instrumentations: [
      // only inside a trace: the relay and the timers of the process ask the database
      // several times a second with nobody waiting for the answer
      new PgInstrumentation({ requireParentSpan: true }),
      new AmqplibInstrumentation(),
      // hands every line of pino to the logs above. The trace of a line is written by our
      // logger (infrastructure/logger/pino.logger.ts), in a container and in a test too
      new PinoInstrumentation({ disableLogCorrelation: true, disableLogSending: !sendLogs }),
    ],
  });
  sdk.start();
  // what is still in the buffer goes out before the process does
  process.once('SIGTERM', () => void sdk.shutdown());
}
