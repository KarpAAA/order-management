import { describe, expect, it } from 'vitest';

import { RecordingLogger } from '@shared/logger/__test__/recording-logger';

import { NestLoggerAdapter } from './nest-logger.adapter';

const STACK = 'Error: boom\n    at handle (/app/dist/handler.js:22:15)';

/** The adapter over a logger that keeps its lines, as a library is given it. */
function adapter() {
  const recorded = new RecordingLogger();
  return { log: new NestLoggerAdapter(recorded.child({ context: 'RabbitMQ' })), recorded };
}

describe('the Nest logger over ours', () => {
  it('LOG-052 a stack given alone is the stack of the line, never its context', () => {
    const { log, recorded } = adapter();

    log.error('Error processing message on handler [onTimeout]', STACK);

    expect(recorded.lines).toEqual([
      {
        level: 'error',
        message: 'Error processing message on handler [onTimeout]',
        fields: { context: 'RabbitMQ', stack: STACK },
      },
    ]);
  });

  it('LOG-052 a stack and a context are told apart, in the order Nest gives them', () => {
    const { log, recorded } = adapter();

    log.error('request failed', STACK, 'ExceptionsHandler');

    expect(recorded.lines[0]?.fields).toEqual({ context: 'ExceptionsHandler', stack: STACK });
  });

  it('the last string names the context of a line', () => {
    const { log, recorded } = adapter();

    log.log('Nest application successfully started', 'NestApplication');
    log.warn('slow');

    expect(recorded.lines).toEqual([
      {
        level: 'info',
        message: 'Nest application successfully started',
        fields: { context: 'NestApplication' },
      },
      { level: 'warn', message: 'slow', fields: { context: 'RabbitMQ' } },
    ]);
  });

  it('an error given as the message is logged under `err`', () => {
    const { log, recorded } = adapter();
    const error = new Error('boom');

    log.error(error);

    expect(recorded.lines[0]).toMatchObject({
      level: 'error',
      message: 'boom',
      fields: { err: error },
    });
  });
});
