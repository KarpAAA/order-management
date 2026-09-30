import { DomainError } from '../errors/domain-error';

export interface PaginatedByCursor<T> {
  items: T[];
  nextCursor: string | null;
}

/** Keyset position: rows are ordered by (createdAt DESC, id DESC). */
export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('Cursor is malformed');
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque to the client: base64url of the sort-key values. */
export function encodeCursor(position: CursorPosition): string {
  const raw = JSON.stringify({ c: position.createdAt.toISOString(), i: position.id });
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'c' in parsed && 'i' in parsed) {
      const { c, i } = parsed;
      const createdAt = typeof c === 'string' ? new Date(c) : new Date(Number.NaN);
      if (!Number.isNaN(createdAt.getTime()) && typeof i === 'string' && UUID.test(i)) {
        return { createdAt, id: i };
      }
    }
  } catch {
    // fall through: any decoding failure is the same client error
  }
  throw new InvalidCursorError();
}

/** Takes `limit + 1` rows, returns `limit` of them and the cursor to the next page. */
export function toCursorPage<TRow extends CursorPosition, TItem>(
  rows: readonly TRow[],
  limit: number,
  map: (row: TRow) => TItem,
): PaginatedByCursor<TItem> {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(map),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

/**
 * Filter for "rows after this cursor" under ORDER BY created_at DESC, id DESC.
 * Plain object so it spreads into any Prisma `where` with `createdAt` and `id`.
 *
 * The conventions' `(created_at, id) < ($1, $2)` is not expressible in Prisma, and `$queryRaw`
 * bypasses the tenant scope. The OR alone is only a Filter: Postgres starts at the newest row
 * and discards every row before the cursor (a hidden OFFSET). The redundant `created_at <=`
 * bound becomes the Index Cond that starts the scan at the cursor (docs/perf/2.2-indexes-explain.md).
 */
export function afterCursor(cursor: string | undefined) {
  if (cursor === undefined) return {};
  const { createdAt, id } = decodeCursor(cursor);
  return {
    createdAt: { lte: createdAt },
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
  };
}

export const newestFirst = () => [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

/** Same as `afterCursor`, for ORDER BY created_at ASC, id ASC (chronological lists). */
export function afterCursorAsc(cursor: string | undefined) {
  if (cursor === undefined) return {};
  const { createdAt, id } = decodeCursor(cursor);
  return {
    createdAt: { gte: createdAt },
    OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: id } }],
  };
}

export const oldestFirst = () => [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
