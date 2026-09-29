import * as argon2 from 'argon2';
import { Factory } from 'fishery';

import type { User } from '@infra/database/generated/prisma/client';
import { newId } from '@shared/domain/id';

import { PASSWORD } from '../seed/ids';
import { testDb } from '../setup/db';

// argon2 is slow on purpose (~50–100 ms): hash PASSWORD once per file, not once per user.
let passwordHash: Promise<string> | undefined;
const hashOnce = (): Promise<string> =>
  (passwordHash ??= argon2.hash(PASSWORD, { type: argon2.argon2id }));

/** A user that can log in with PASSWORD. Not a member of anything until membershipFactory. */
export const userFactory = Factory.define<User>(({ sequence, onCreate }) => {
  onCreate(async (user) => {
    const hash = user.passwordHash === '' ? await hashOnce() : user.passwordHash;
    return testDb().user.create({ data: { ...user, passwordHash: hash } });
  });

  const now = new Date();
  return {
    id: newId(),
    email: `user-${String(sequence)}@factory.test`, // stored lower-cased, globally unique
    passwordHash: '', // '' → the shared hash of PASSWORD on create
    createdAt: now,
    updatedAt: now,
  };
});
