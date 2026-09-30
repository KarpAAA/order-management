import { describe, expect, it } from 'vitest';

import {
  afterCursor,
  afterCursorAsc,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  toCursorPage,
} from './cursor';

const position = {
  createdAt: new Date('2026-06-12T08:40:55.127Z'),
  id: '019ebafd-ca57-74cb-b947-25ddb73e72ac',
};
const cursor = encodeCursor(position);

describe('cursor encoding', () => {
  it('round-trips the sort-key values', () => {
    expect(decodeCursor(cursor)).toEqual(position);
  });

  it.each([
    ['not base64 json', 'garbage'],
    ['a bad date', Buffer.from(JSON.stringify({ c: 'x', i: position.id })).toString('base64url')],
    ['a bad id', Buffer.from(JSON.stringify({ c: '2026-01-01', i: '1' })).toString('base64url')],
  ])('rejects %s', (_, value) => {
    expect(() => decodeCursor(value)).toThrow(InvalidCursorError);
  });
});

describe('afterCursor (newest first)', () => {
  it('is empty without a cursor', () => {
    expect(afterCursor(undefined)).toEqual({});
  });

  // The `lte` bound is redundant for the result and exists for the index: without it the
  // cursor is only a Filter and deep pages read every newer row (docs/perf/2.2-indexes-explain.md).
  it('bounds created_at so the index scan starts at the cursor, then breaks ties by id', () => {
    expect(afterCursor(cursor)).toEqual({
      createdAt: { lte: position.createdAt },
      OR: [
        { createdAt: { lt: position.createdAt } },
        { createdAt: position.createdAt, id: { lt: position.id } },
      ],
    });
  });
});

describe('afterCursorAsc (oldest first)', () => {
  it('is empty without a cursor', () => {
    expect(afterCursorAsc(undefined)).toEqual({});
  });

  it('bounds created_at from below, then breaks ties by id', () => {
    expect(afterCursorAsc(cursor)).toEqual({
      createdAt: { gte: position.createdAt },
      OR: [
        { createdAt: { gt: position.createdAt } },
        { createdAt: position.createdAt, id: { gt: position.id } },
      ],
    });
  });
});

describe('toCursorPage', () => {
  const rows = [1, 2, 3].map((n) => ({
    createdAt: new Date(Date.UTC(2026, 0, n)),
    id: `0190000${String(n)}-0000-7000-8000-000000000000`,
  }));

  it('returns limit rows and the cursor of the last one when there is one more', () => {
    const page = toCursorPage(rows, 2, (row) => row.id);
    expect(page.items).toEqual([rows[0]!.id, rows[1]!.id]);
    expect(decodeCursor(page.nextCursor!)).toEqual(rows[1]);
  });

  it('has no next cursor on the last page', () => {
    expect(toCursorPage(rows, 3, (row) => row.id).nextCursor).toBeNull();
  });
});
