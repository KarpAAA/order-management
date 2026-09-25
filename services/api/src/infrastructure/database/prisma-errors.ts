import { Prisma } from './generated/prisma/client';

/** P2002: a unique constraint rejected the write. Repositories turn it into a ConflictError. */
export const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** P2025: `update`/`delete` found no row matching the (tenant-scoped) where. */
export const isRecordNotFound = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
