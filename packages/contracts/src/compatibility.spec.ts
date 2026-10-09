import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { breakingChanges } from './compatibility';
import { defineMessage } from './envelope';

const line = z.object({ productId: z.uuid(), quantity: z.int().positive() });

const payload = z.object({
  orderId: z.uuid(),
  chargeId: z.string().min(1),
  declineCode: z.string().min(1).nullable(),
  amount: z.object({ amountMinor: z.int().nonnegative(), currency: z.string() }),
  lines: z.array(line).min(1),
  note: z.string().optional(),
});

const schemaOf = (body: z.ZodType): unknown =>
  z.toJSONSchema(defineMessage('orders.order-paid', 1, body).schema, { io: 'input' });

const RELEASED = schemaOf(payload);

const changed = (body: z.ZodType): string[] => breakingChanges(RELEASED, schemaOf(body));

describe('CTR-003 breakingChanges', () => {
  it('accepts the schema it was released as', () => {
    expect(changed(payload)).toEqual([]);
  });

  it.each([
    ['in the payload', payload.extend({ addedLater: z.string().optional() })],
    [
      'in an object of the payload',
      payload.extend({ amount: payload.shape.amount.extend({ scale: z.int().optional() }) }),
    ],
    [
      'in the items of a list',
      payload.extend({ lines: z.array(line.extend({ sku: z.string().optional() })).min(1) }),
    ],
  ])('accepts a field that is not required, added %s', (_where, body) => {
    expect(changed(body)).toEqual([]);
  });

  it('refuses a removed field', () => {
    expect(changed(payload.omit({ chargeId: true }))).toEqual(['payload.chargeId: removed']);
  });

  it('refuses a renamed field: one removed, one new and required', () => {
    const renamed = payload.omit({ chargeId: true }).extend({ pspChargeId: z.string().min(1) });

    expect(changed(renamed)).toEqual([
      'payload.chargeId: removed',
      'payload.pspChargeId: new required field',
    ]);
  });

  it('refuses a new required field', () => {
    expect(changed(payload.extend({ recipient: z.email() }))).toEqual([
      'payload.recipient: new required field',
    ]);
  });

  it('refuses a field that became required', () => {
    expect(changed(payload.extend({ note: z.string() }))).toEqual([
      'payload.note: became required',
    ]);
  });

  it('refuses a field that is no longer required: a reader built before still asks for it', () => {
    expect(changed(payload.extend({ chargeId: z.string().min(1).optional() }))).toEqual([
      'payload.chargeId: no longer required',
    ]);
  });

  it('refuses another type', () => {
    expect(changed(payload.extend({ chargeId: z.int() }))).toEqual([
      'payload.chargeId: type changed ("string" → "integer")',
      'payload.chargeId: minLength changed (1 → none)',
      'payload.chargeId: minimum changed (none → -9007199254740991)',
      'payload.chargeId: maximum changed (none → 9007199254740991)',
    ]);
  });

  it.each([
    ['tighter', z.string().min(2), 'payload.chargeId: minLength changed (1 → 2)'],
    ['looser', z.string(), 'payload.chargeId: minLength changed (1 → none)'],
  ])('refuses a %s constraint', (_case, chargeId, change) => {
    expect(changed(payload.extend({ chargeId }))).toEqual([change]);
  });

  it('refuses a field that may no longer be null', () => {
    const [change] = changed(payload.extend({ declineCode: z.string().min(1) }));

    expect(change).toMatch(/^payload\.declineCode: anyOf changed/);
  });

  it('refuses a change inside a field that may be null', () => {
    expect(changed(payload.extend({ declineCode: z.string().min(3).nullable() }))).toEqual([
      'payload.declineCode: minLength changed (1 → 3)',
    ]);
  });

  it('refuses a change in an object of the payload, by its path', () => {
    const amount = payload.shape.amount.omit({ currency: true });

    expect(changed(payload.extend({ amount }))).toEqual(['payload.amount.currency: removed']);
  });

  it('refuses a change in the items of a list, by its path', () => {
    const lines = z.array(line.extend({ quantity: z.string() })).min(1);

    expect(changed(payload.extend({ lines }))[0]).toBe(
      'payload.lines[].quantity: type changed ("integer" → "string")',
    );
  });

  it('refuses a list that may be empty now', () => {
    expect(changed(payload.extend({ lines: z.array(line) }))).toEqual([
      'payload.lines: minItems changed (1 → none)',
    ]);
  });

  it('refuses another name or version in the envelope', () => {
    const next = z.toJSONSchema(defineMessage('orders.order-paid', 2, payload).schema, {
      io: 'input',
    });

    expect(breakingChanges(RELEASED, next)).toEqual(['version: const changed (1 → 2)']);
  });
});
