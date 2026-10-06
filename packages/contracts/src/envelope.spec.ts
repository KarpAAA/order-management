import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineMessage, type MessageMeta } from './envelope';

const META: MessageMeta = {
  messageId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e01',
  occurredAt: new Date('2026-10-06T10:15:30.123Z'),
  workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
  correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
};

const Sample = defineMessage('samples.sample-made', 1, z.object({ label: z.string().min(1) }));

describe('defineMessage', () => {
  it('builds a message with the contract name, its version and the date as an ISO string', () => {
    expect(Sample.create(META, { label: 'a' })).toEqual({
      messageId: META.messageId,
      name: 'samples.sample-made',
      version: 1,
      occurredAt: '2026-10-06T10:15:30.123Z',
      workspaceId: META.workspaceId,
      correlationId: META.correlationId,
      payload: { label: 'a' },
    });
  });

  it('refuses to build a message its own schema rejects', () => {
    expect(() => Sample.create(META, { label: '' })).toThrow();
    expect(() => Sample.create({ ...META, workspaceId: 'not-a-uuid' }, { label: 'a' })).toThrow();
  });

  it('survives JSON: what a sender serializes, a consumer parses to the same message', () => {
    const sent = Sample.create(META, { label: 'a' });

    expect(Sample.schema.parse(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  });

  it('drops unknown keys instead of rejecting them, in the envelope and in the payload', () => {
    const sent = Sample.create(META, { label: 'a' });
    const fromNewerSender = { ...sent, traceId: 'x', payload: { ...sent.payload, note: 'y' } };

    expect(Sample.schema.parse(fromNewerSender)).toEqual(sent);
  });

  it.each([
    ['another version', { version: 2 }],
    ['another name', { name: 'samples.sample-lost' }],
    ['a message id that is not a uuid', { messageId: '42' }],
    ['a date that is not an ISO string', { occurredAt: 1_759_745_730_123 }],
    ['a date with an offset instead of UTC', { occurredAt: '2026-10-06T12:15:30+02:00' }],
    ['no workspace', { workspaceId: undefined }],
    ['no correlation id', { correlationId: undefined }],
    ['no payload', { payload: undefined }],
  ])('rejects %s', (_case, change) => {
    const message = { ...Sample.create(META, { label: 'a' }), ...change };

    expect(Sample.schema.safeParse(message).success).toBe(false);
  });
});
