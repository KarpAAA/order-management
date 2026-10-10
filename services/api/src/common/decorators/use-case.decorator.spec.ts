import { Test } from '@nestjs/testing';
import { SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';

import { recordingTracer } from '@common/tracing/__test__/recording-tracer';
import { systemActor, userActor, type Actor } from '@shared/auth/actor';
import { InvalidStateError } from '@shared/errors/domain-error';
import { RecordingLogger } from '@shared/logger/__test__/recording-logger';
import { LOGGER } from '@shared/logger/logger';

import { UseCase } from './use-case.decorator';

class NotPayable extends InvalidStateError {
  readonly code = 'ORDER_NOT_PAYABLE';
}

@UseCase()
class PayOrderService {
  readonly actors: Actor[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await -- the shape of a use case
  async execute(cmd: { orderId: string; fail?: Error }, actor: Actor): Promise<string> {
    this.actors.push(actor);
    if (cmd.fail !== undefined) throw cmd.fail;
    return `paid ${cmd.orderId}`;
  }
}

describe('@UseCase(): the line of a use case (ops/logging.md §3, LOG-020)', () => {
  /** The use case as the injector builds it, with the logger of the process. */
  async function provided() {
    const logger = new RecordingLogger();
    const moduleRef = await Test.createTestingModule({
      providers: [PayOrderService, { provide: LOGGER, useValue: logger }],
    }).compile();
    return { useCase: moduleRef.get(PayOrderService), logger };
  }

  it('logs a use case that succeeded: which one, for whom, how long', async () => {
    const { useCase, logger } = await provided();

    const result = await useCase.execute({ orderId: 'o-1' }, userActor('u-1'));

    expect(result).toBe('paid o-1');
    expect(logger.lines).toEqual([
      {
        level: 'info',
        message: 'use case',
        fields: {
          context: 'UseCase',
          useCase: 'PayOrderService',
          actor: 'u-1',
          durationMs: expect.any(Number),
          outcome: 'ok',
        },
      },
    ]);
  });

  it('logs what business answered with as the outcome, at warn, and lets the error out', async () => {
    const { useCase, logger } = await provided();
    const refusal = new NotPayable('order o-1 is not waiting for a payment');

    await expect(
      useCase.execute({ orderId: 'o-1', fail: refusal }, systemActor('consumer:orders')),
    ).rejects.toBe(refusal);

    expect(logger.lines).toMatchObject([
      {
        level: 'warn',
        fields: {
          useCase: 'PayOrderService',
          actor: 'system:consumer:orders',
          outcome: 'ORDER_NOT_PAYABLE',
        },
      },
    ]);
  });

  it('calls anything else an error, and leaves the error itself to the entry that logs it', async () => {
    const { useCase, logger } = await provided();
    const bug = new TypeError('undefined is not a function');

    await expect(useCase.execute({ orderId: 'o-1', fail: bug }, userActor('u-1'))).rejects.toBe(
      bug,
    );

    expect(logger.lines).toMatchObject([{ level: 'warn', fields: { outcome: 'error' } }]);
    expect(logger.lines[0]?.fields).not.toHaveProperty('err');
  });

  it('never logs the command: it is the body of a request', async () => {
    const { useCase, logger } = await provided();

    await useCase.execute({ orderId: 'o-1' }, userActor('u-1'));

    expect(JSON.stringify(logger.lines)).not.toContain('o-1');
  });

  it('works without a logger: a use case a unit test builds by hand', async () => {
    await expect(new PayOrderService().execute({ orderId: 'o-1' }, userActor('u-1'))).resolves.toBe(
      'paid o-1',
    );
  });
});

describe('@UseCase(): the span of a use case (ops/observability.md §3, TRC-020)', () => {
  const tracing = recordingTracer();

  it('is a span named after the use case, with the kind of its actor and the outcome', async () => {
    tracing.reset();

    await new PayOrderService().execute({ orderId: 'o-1' }, userActor('u-1'));

    const span = tracing.span('PayOrderService');
    expect(span?.attributes).toEqual({ 'actor.kind': 'user', outcome: 'ok' });
    expect(JSON.stringify(span?.attributes)).not.toContain('u-1');
  });

  it('TRC-021 a refusal of the business is an outcome, anything else an error of the span', async () => {
    tracing.reset();
    const useCase = new PayOrderService();

    await useCase
      .execute({ orderId: 'o-1', fail: new NotPayable('no') }, systemActor('job:x'))
      .catch(() => undefined);
    await useCase
      .execute({ orderId: 'o-1', fail: new TypeError('bug') }, systemActor('job:x'))
      .catch(() => undefined);

    const [refused, failed] = tracing.spans();
    expect(refused?.attributes).toMatchObject({
      'actor.kind': 'system',
      outcome: 'ORDER_NOT_PAYABLE',
    });
    expect(refused?.status.code).toBe(SpanStatusCode.UNSET);
    expect(failed?.attributes).toMatchObject({ outcome: 'error' });
    expect(failed?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
