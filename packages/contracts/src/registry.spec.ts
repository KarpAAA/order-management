import { describe, expect, it } from 'vitest';

import { contractKey, contracts, parseMessage } from './registry';

import * as api from './index';

import type { MessageMeta } from './envelope';

const META: MessageMeta = {
  messageId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e01',
  occurredAt: new Date('2026-10-06T10:15:30.123Z'),
  workspaceId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e02',
  correlationId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03',
};

const succeeded = api.PaymentSucceededV1.create(META, {
  orderId: '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04',
  paymentAttempt: 1,
  chargeId: 'ch_1',
});

const isContract = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'schema' in value && 'create' in value;

describe('contracts', () => {
  it('has one contract per name and version', () => {
    const keys = contracts.map((c) => contractKey(c.name, c.version));

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists every contract the package exports', () => {
    const exported = Object.values(api).filter(isContract);

    expect(exported).toHaveLength(contracts.length);
    expect(exported).toEqual(expect.arrayContaining([...contracts]));
  });
});

describe('parseMessage', () => {
  it('picks the schema by name and version', () => {
    const result = parseMessage(JSON.parse(JSON.stringify(succeeded)));

    expect(result).toEqual({ ok: true, message: succeeded });
  });

  it.each([
    ['null', null],
    ['a string', 'payments.payment-succeeded'],
    ['an object with no name', { version: 1 }],
    ['an object with no version', { name: 'payments.payment-succeeded' }],
    ['a version sent as a string', { ...succeeded, version: '1' }],
  ])('reports %s as malformed', (_case, raw) => {
    expect(parseMessage(raw)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('reports a version it does not know as unknown, with the key', () => {
    expect(parseMessage({ ...succeeded, version: 2 })).toEqual({
      ok: false,
      reason: 'unknown',
      detail: 'payments.payment-succeeded@2',
    });
  });

  it('reports a name it does not know as unknown', () => {
    expect(parseMessage({ ...succeeded, name: 'payments.payment-refunded' })).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
  });

  it('reports a known contract with a wrong payload as invalid, naming the field', () => {
    const result = parseMessage({ ...succeeded, payload: { ...succeeded.payload, chargeId: 7 } });

    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    expect(result).toHaveProperty('detail', expect.stringContaining('chargeId'));
  });
});
