import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';

import { CorrelationContext } from './correlation-context';
import { correlationIdFrom } from './correlation-id';

const ID = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e03';
const OTHER = '01927f4e-8b2a-7c3d-9e4f-5a6b7c8d9e04';

const cls = ClsServiceManager.getClsService();
const correlation = () => new CorrelationContext(cls);

describe('correlationIdFrom: an id that may be continued (LOG-010)', () => {
  it('takes a UUID, in lower case', () => {
    expect(correlationIdFrom(ID)).toBe(ID);
    expect(correlationIdFrom(ID.toUpperCase())).toBe(ID);
  });

  it.each([
    ['nothing', undefined],
    ['a word', 'my-request'],
    ['a line break (log injection)', `${ID}\n{"level":"error"}`],
    ['a number', 42],
  ])('does not take %s', (_case, value) => {
    expect(correlationIdFrom(value)).toBeUndefined();
  });
});

describe('CorrelationContext (LOG-011)', () => {
  it('has no id outside a chain', () => {
    expect(correlation().current()).toBeUndefined();
  });

  it('runs work as a part of a chain, and leaves the chain with it', async () => {
    const context = correlation();

    const inside = await context.run(ID, async () => {
      await Promise.resolve();
      return context.current();
    });

    expect(inside).toBe(ID);
    expect(context.current()).toBeUndefined();
  });

  it('keeps two chains apart while they run at once', async () => {
    const context = correlation();
    const seen = (id: string) =>
      context.run(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return context.current();
      });

    expect(await Promise.all([seen(ID), seen(OTHER)])).toEqual([ID, OTHER]);
  });

  it('inherits what the scope around it holds: a nested chain does not leave a transaction', () => {
    const context = correlation();
    const HELD = Symbol('held');

    const held = cls.run(() => {
      cls.set(HELD, 'transaction');
      return context.run(ID, () => cls.get<string>(HELD));
    });

    expect(held).toBe('transaction');
  });

  it('continues another chain inside a scope: what follows belongs to it, and only there', () => {
    const context = correlation();

    const seen = context.run(ID, () => {
      const nested = cls.run(() => {
        context.continue(OTHER);
        return context.current();
      });
      return [nested, context.current()];
    });

    expect(seen).toEqual([OTHER, ID]);
  });
});
