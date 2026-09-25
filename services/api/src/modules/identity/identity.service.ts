import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Transactional, TransactionHost } from '@nestjs-cls/transactional';
import * as argon2 from 'argon2';

import { TenantContext } from '@common/tenancy/tenant-context';
import { authConfig, type AuthConfig } from '@config/configuration';
import type { DbTransactionAdapter } from '@infra/database/database.tokens';
import { isUniqueViolation } from '@infra/database/prisma-errors';
import type { Actor, UserActor } from '@shared/auth/actor';
import type { WorkspaceRole } from '@shared/auth/workspace-role';
import { newId } from '@shared/domain/id';
import { AuthenticationError } from '@shared/errors/authentication-error';

import {
  AlreadyMemberError,
  EmailAlreadyRegisteredError,
  UserNotFoundError,
  WorkspaceSlugTakenError,
} from './errors';
import { IdentityPolicy } from './identity.policy';

export interface RegisterCommand {
  email: string;
  password: string;
}

export interface CreateWorkspaceCommand {
  name: string;
  slug: string;
  currency: string;
  taxRateBps: number;
}

export interface AddMemberCommand {
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Write path of identity (level 1: Prisma directly, rules in the policy). */
@Injectable()
export class IdentityService {
  // Verified against when the email is unknown, so both paths take the same time.
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly txHost: TransactionHost<DbTransactionAdapter>,
    private readonly policy: IdentityPolicy,
    private readonly tenant: TenantContext,
    private readonly jwt: JwtService,
    @Inject(authConfig.KEY) private readonly auth: AuthConfig,
  ) {}

  /** Anonymous by definition: there is no actor before an account exists. */
  async register(cmd: RegisterCommand): Promise<{ id: string }> {
    const id = newId();
    const passwordHash = await argon2.hash(cmd.password, { type: argon2.argon2id });
    try {
      await this.txHost.tx.user.create({
        data: { id, email: normalizeEmail(cmd.email), passwordHash },
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new EmailAlreadyRegisteredError();
      throw err;
    }
    return { id };
  }

  async login(cmd: RegisterCommand): Promise<{ accessToken: string; expiresIn: number }> {
    const user = await this.txHost.tx.user.findUnique({
      where: { email: normalizeEmail(cmd.email) },
      select: { id: true, passwordHash: true },
    });
    const hash = user?.passwordHash ?? (await this.getDummyHash());
    const valid = await argon2.verify(hash, cmd.password);
    if (!user || !valid) throw new AuthenticationError();

    const expiresIn = this.auth.accessTtlSeconds;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id },
      { secret: this.auth.jwtSecret, algorithm: 'HS256', expiresIn, jwtid: newId() },
    );
    return { accessToken, expiresIn };
  }

  /** The creator becomes OWNER in the same transaction. */
  @Transactional()
  async createWorkspace(cmd: CreateWorkspaceCommand, actor: UserActor): Promise<{ id: string }> {
    const id = newId();
    try {
      // Nested create: the only write into a tenant table that enters through a global model
      // (docs/architecture.md → Tenancy). There is no tenant context yet: the workspace is new.
      await this.txHost.tx.workspace.create({
        data: {
          id,
          name: cmd.name,
          slug: cmd.slug,
          currency: cmd.currency,
          taxRateBps: cmd.taxRateBps,
          memberships: { create: { id: newId(), userId: actor.userId, role: 'OWNER' } },
        },
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new WorkspaceSlugTakenError(cmd.slug);
      throw err;
    }
    return { id };
  }

  async addMember(cmd: AddMemberCommand, actor: Actor): Promise<{ id: string }> {
    this.policy.assertCanAddMember(actor, this.tenant.membership(), cmd.role);

    const user = await this.txHost.tx.user.findUnique({
      where: { email: normalizeEmail(cmd.email) },
      select: { id: true },
    });
    if (!user) throw new UserNotFoundError();

    const id = newId();
    try {
      await this.txHost.tx.membership.create({
        data: { workspaceId: cmd.workspaceId, id, userId: user.id, role: cmd.role },
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new AlreadyMemberError(user.id);
      throw err;
    }
    return { id };
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= argon2.hash(newId(), { type: argon2.argon2id });
    return this.dummyHash;
  }
}
