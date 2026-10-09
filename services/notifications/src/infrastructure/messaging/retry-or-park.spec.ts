import { describe, expect, it, vi } from 'vitest';

import { UnprocessableMessageError } from '@shared/errors/unprocessable-message.error';

import { deliveryOf, retryOrPark } from './retry-or-park';

import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

const QUEUE = 'notifications.order-events';
const POLICY = { maxAttempts: 3, delayMs: 200 };

/** A delivery the broker has dead-lettered from the queue `rejected` times before. */
function delivered(rejected = 0, headers: Record<string, unknown> = {}): ConsumeMessage {
  const deaths = [
    { queue: QUEUE, reason: 'rejected', count: rejected },
    { queue: `${QUEUE}.wait.200`, reason: 'expired', count: rejected },
  ];
  return {
    content: Buffer.from('{"name":"orders.order-paid"}'),
    fields: {},
    properties: { headers: rejected > 0 ? { ...headers, 'x-death': deaths } : headers },
  } as unknown as ConsumeMessage;
}

function channelThat({ confirms = true } = {}) {
  const sendToQueue = vi.fn(
    (_queue: string, _content: Buffer, _options: unknown, done: (err: unknown) => void) => {
      done(confirms ? null : new Error('nacked by the broker'));
      return true;
    },
  );
  const channel = { ack: vi.fn(), nack: vi.fn(), sendToQueue };
  return { channel, asChannel: channel as unknown as ConfirmChannel };
}

const logger = () => ({ warn: vi.fn(), error: vi.fn() });

describe('deliveryOf', () => {
  it.each([
    [0, { attempt: 1, last: false }],
    [1, { attempt: 2, last: false }],
    [2, { attempt: 3, last: true }],
    [7, { attempt: 8, last: true }],
  ])('after %i rejections → %o', (rejected, expected) => {
    expect(deliveryOf(delivered(rejected), QUEUE, POLICY)).toEqual(expected);
  });

  it('counts the rejections of this queue only', () => {
    const message = delivered(0, {
      'x-death': [
        { queue: 'another.queue', reason: 'rejected', count: 5 },
        { queue: QUEUE, reason: 'expired', count: 5 },
      ],
    });
    expect(deliveryOf(message, QUEUE, POLICY)).toEqual({ attempt: 1, last: false });
  });

  it('is the first and the last delivery when the policy allows one', () => {
    expect(deliveryOf(delivered(), QUEUE, { maxAttempts: 1, delayMs: 200 }).last).toBe(true);
  });
});

describe('retryOrPark', () => {
  it('rejects without requeue while a delivery is left: the broker moves it to the wait queue', async () => {
    const { channel, asChannel } = channelThat();
    const log = logger();
    const message = delivered(1);

    await retryOrPark(QUEUE, POLICY, log)(asChannel, message, new Error('database is down'));

    expect(channel.nack).toHaveBeenCalledExactlyOnceWith(message, false, false);
    expect(channel.sendToQueue).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('parks the last delivery in the dead-letter queue, then acknowledges it', async () => {
    const { channel, asChannel } = channelThat();
    const log = logger();
    const message = delivered(2, { 'x-custom': 'kept' });

    await retryOrPark(QUEUE, POLICY, log)(asChannel, message, new Error('still down'));

    expect(channel.sendToQueue).toHaveBeenCalledExactlyOnceWith(
      'notifications.order-events.dlq',
      message.content,
      {
        persistent: true,
        headers: {
          'x-custom': 'kept',
          'x-parked-from': QUEUE,
          // the broker's record moves aside: put back, the message is delivered afresh
          'x-parked-deaths': expect.arrayContaining([
            { queue: QUEUE, reason: 'rejected', count: 2 },
          ]),
          'x-last-error': 'Error: still down',
        },
      },
      expect.any(Function),
    );
    expect(channel.ack).toHaveBeenCalledExactlyOnceWith(message);
    expect(channel.nack).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('parks what cannot be processed on its first delivery', async () => {
    const { channel, asChannel } = channelThat();
    const message = delivered(0);

    await retryOrPark(QUEUE, POLICY, logger())(
      asChannel,
      message,
      new UnprocessableMessageError('unknown-contract: no such name'),
    );

    expect(channel.sendToQueue).toHaveBeenCalledOnce();
    expect(channel.ack).toHaveBeenCalledExactlyOnceWith(message);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('does not acknowledge a message the broker refused to park: it waits and is parked later', async () => {
    const { channel, asChannel } = channelThat({ confirms: false });
    const log = logger();
    const message = delivered(2);

    await retryOrPark(QUEUE, POLICY, log)(asChannel, message, new Error('still down'));

    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledExactlyOnceWith(message, false, false);
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('never throws when the channel is gone: the broker has the message back already', async () => {
    const { channel, asChannel } = channelThat();
    channel.nack.mockImplementation(() => {
      throw new Error('Channel closed');
    });

    await expect(
      retryOrPark(QUEUE, POLICY, logger())(asChannel, delivered(0), new Error('database is down')),
    ).resolves.toBeUndefined();
  });
});
