import { describe, expect, it } from 'vitest';

import { RecordingLogger } from '@shared/logger/__test__/recording-logger';

import { LibraryLogger } from './library-logger';

const STACK = 'Error: no saga\n    at handleOnce (/app/dist/handle-once.js:22:15)';

describe('the logger of the broker library', () => {
  it('LOG-053 a handler that threw is not an error line of the library: the delivery has its own', () => {
    const recorded = new RecordingLogger();
    const log = new LibraryLogger(recorded.child({ context: 'RabbitMQ' }));

    log.error('Error processing message on handler [onTimeout]', STACK);

    expect(recorded.at('error')).toEqual([]);
    expect(recorded.at('debug')).toEqual([
      {
        level: 'debug',
        message: 'Error processing message on handler [onTimeout]',
        fields: { context: 'RabbitMQ', stack: STACK },
      },
    ]);
  });

  it('LOG-053 anything else the library reports as an error stays one', () => {
    const recorded = new RecordingLogger();
    const log = new LibraryLogger(recorded.child({ context: 'RabbitMQ' }));

    log.error('Disconnected from RabbitMQ broker (api)');

    expect(recorded.at('error').map((line) => line.message)).toEqual([
      'Disconnected from RabbitMQ broker (api)',
    ]);
  });
});
