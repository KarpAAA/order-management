import { Global, Module } from '@nestjs/common';

import { CorrelationContext } from '@common/messaging/correlation-context';
import { JobScope } from '@common/messaging/job-scope';
import { loggingConfig, type LoggingConfig } from '@config/configuration';
import { LOGGER } from '@shared/logger/logger';

import { NestLoggerAdapter } from './nest-logger.adapter';
import { createPinoLogger, logDestination } from './pino.logger';

import type { DynamicModule } from '@nestjs/common';
import type { DestinationStream } from 'pino';

/** Where the lines are written: stdout. A test puts a stream of its own here and reads it. */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');
/** Which process of the service this is (`api`, `worker`): a field of every line, a label of every metric. */
export const PROCESS_NAME = Symbol('PROCESS_NAME');

const SERVICE = 'api';

/**
 * The logger of the process and the correlation id it reads (docs/adr/0023): structured JSON
 * through pino, one logger, injected as `LOGGER`. Nothing else may write a log line: no
 * `console`, no `Logger` of Nest (lint).
 */
@Global()
@Module({
  providers: [
    CorrelationContext,
    JobScope,
    NestLoggerAdapter,
    {
      provide: LOG_DESTINATION,
      inject: [loggingConfig.KEY],
      useFactory: (config: LoggingConfig) => logDestination(config),
    },
    {
      provide: LOGGER,
      inject: [
        loggingConfig.KEY,
        CorrelationContext,
        LOG_DESTINATION,
        { token: PROCESS_NAME, optional: true },
      ],
      useFactory: (
        config: LoggingConfig,
        correlation: CorrelationContext,
        destination: DestinationStream,
        process?: string,
      ) =>
        createPinoLogger({
          config,
          base: { service: SERVICE, ...(process === undefined ? {} : { process }) },
          correlationId: () => correlation.current(),
          destination,
        }),
    },
  ],
  exports: [LOGGER, LOG_DESTINATION, CorrelationContext, JobScope, NestLoggerAdapter],
})
export class LoggerModule {}

/** Imported by an entrypoint module, beside `SharedModule`: names its process in the logs. */
@Global()
@Module({})
export class ProcessNameModule {
  static is(process: string): DynamicModule {
    return {
      module: ProcessNameModule,
      providers: [{ provide: PROCESS_NAME, useValue: process }],
      exports: [PROCESS_NAME],
    };
  }
}
