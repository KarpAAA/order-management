import { Global, Module } from '@nestjs/common';

import { loggingConfig, type LoggingConfig } from '@config/configuration';
import { LOGGER } from '@shared/logger/logger';
import { CORRELATION } from '@shared/messaging/correlation';

import { CorrelationContext } from '../correlation/correlation-context';

import { NestLoggerAdapter } from './nest-logger.adapter';
import { createPinoLogger, logDestination } from './pino.logger';

import type { DestinationStream } from 'pino';

/** Where the lines are written: stdout. A test puts a stream of its own here and reads it. */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

const SERVICE = 'payments';

/**
 * The logger of the process and the correlation id it reads (docs/adr/0023): structured JSON
 * through pino, one logger, injected as `LOGGER`. Nothing else may write a log line: no
 * `console`, no `Logger` of Nest (lint). A copy of the api's, without its HTTP and job parts.
 */
@Global()
@Module({
  providers: [
    CorrelationContext,
    { provide: CORRELATION, useExisting: CorrelationContext },
    NestLoggerAdapter,
    {
      provide: LOG_DESTINATION,
      inject: [loggingConfig.KEY],
      useFactory: (config: LoggingConfig) => logDestination(config),
    },
    {
      provide: LOGGER,
      inject: [loggingConfig.KEY, CorrelationContext, LOG_DESTINATION],
      useFactory: (
        config: LoggingConfig,
        correlation: CorrelationContext,
        destination: DestinationStream,
      ) =>
        createPinoLogger({
          config,
          base: { service: SERVICE },
          correlationId: () => correlation.current(),
          destination,
        }),
    },
  ],
  exports: [LOGGER, LOG_DESTINATION, CORRELATION, NestLoggerAdapter],
})
export class LoggerModule {}
