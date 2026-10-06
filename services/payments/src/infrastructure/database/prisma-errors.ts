import { Prisma } from './generated/prisma/client';

/** P2002: a unique constraint rejected the write. */
export const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
