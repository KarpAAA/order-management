import { Inject, Injectable } from '@nestjs/common';

import { TenantContext } from '@common/tenancy/tenant-context';
import { READ_DB, type ReadDb } from '@infra/database/database.tokens';
import { PrismaService } from '@infra/database/prisma.service';
import type { UserActor } from '@shared/auth/actor';
import type { WorkspaceMembership, WorkspaceRole } from '@shared/auth/workspace-role';
import { afterCursor, newestFirst, toCursorPage } from '@shared/pagination/cursor';
import type { PaginatedByCursor } from '@shared/pagination/cursor';
import { WorkspaceNotFoundError } from '@shared/tenancy/workspace-not-found.error';

import { UserNotFoundError } from '../errors';

import type { MeDto, MemberDto, WorkspaceDto } from '../identity.dto';

// A user belongs to a handful of workspaces; this bounds the /me payload.
const MAX_MEMBERSHIPS_ON_ME = 100;

const workspaceSelect = {
  id: true,
  name: true,
  slug: true,
  currency: true,
  taxRateBps: true,
  createdAt: true,
} as const;

/**
 * Read path of identity. Two handles, on purpose:
 * - `db` (tenant-scoped) for everything inside the current workspace;
 * - `unscoped` ONLY for the questions that are cross-tenant by nature — "which workspaces
 *   am I in" and the membership lookup the access guard runs before a tenant exists.
 *   These are the documented exceptions to the tenant choke point. They run `asUser`: the
 *   database shows a user their own memberships and no one else's (Row-Level Security).
 */
@Injectable()
export class IdentityQueryService {
  constructor(
    @Inject(READ_DB) private readonly db: ReadDb,
    private readonly unscoped: PrismaService,
    private readonly tenant: TenantContext,
  ) {}

  async me(actor: UserActor): Promise<MeDto> {
    const user = await this.db.user.findUnique({
      where: { id: actor.userId },
      select: { id: true, email: true, createdAt: true },
    });
    if (!user) throw new UserNotFoundError();
    const memberships = await this.unscoped.asUser(
      actor.userId,
      this.unscoped.membership.findMany({
        where: { userId: actor.userId },
        select: { role: true, workspace: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: 'asc' },
        take: MAX_MEMBERSHIPS_ON_ME,
      }),
    );
    return {
      ...user,
      memberships: memberships.map((m) => ({
        workspaceId: m.workspace.id,
        workspaceName: m.workspace.name,
        workspaceSlug: m.workspace.slug,
        role: m.role as WorkspaceRole, // Prisma enum → domain enum, identical values
      })),
    };
  }

  async listMyWorkspaces(
    actor: UserActor,
    page: { cursor?: string; limit: number },
  ): Promise<PaginatedByCursor<WorkspaceDto>> {
    const rows = await this.unscoped.asUser(
      actor.userId,
      this.unscoped.membership.findMany({
        where: { userId: actor.userId, ...afterCursor(page.cursor) },
        select: { id: true, createdAt: true, role: true, workspace: { select: workspaceSelect } },
        orderBy: newestFirst(),
        take: page.limit + 1,
      }),
    );
    return toCursorPage(rows, page.limit, (row) => ({
      ...row.workspace,
      myRole: row.role as WorkspaceRole,
    }));
  }

  /** Called after the access guard: the caller is a member of `workspaceId`. */
  async getWorkspace(workspaceId: string): Promise<WorkspaceDto> {
    const membership = this.requireMembership();
    const workspace = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: workspaceSelect,
    });
    if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
    return { ...workspace, myRole: membership.role };
  }

  async listMembers(page: {
    cursor?: string;
    limit: number;
  }): Promise<PaginatedByCursor<MemberDto>> {
    const rows = await this.db.membership.findMany({
      where: afterCursor(page.cursor),
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { email: true } },
      },
      orderBy: newestFirst(),
      take: page.limit + 1,
    });
    return toCursorPage(rows, page.limit, (row) => ({
      id: row.id,
      userId: row.userId,
      email: row.user.email,
      role: row.role as WorkspaceRole,
      createdAt: row.createdAt,
    }));
  }

  /** Cross-tenant by nature: runs before the tenant context exists. */
  async findMembership(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
    const row = await this.unscoped.asUser(
      userId,
      this.unscoped.membership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { workspaceId: true, userId: true, role: true },
      }),
    );
    return row ? { ...row, role: row.role as WorkspaceRole } : null;
  }

  async getWorkspaceTerms(workspaceId: string): Promise<{ currency: string; taxRateBps: number }> {
    const row = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { currency: true, taxRateBps: true },
    });
    if (!row) throw new WorkspaceNotFoundError(workspaceId);
    return row;
  }

  private requireMembership(): WorkspaceMembership {
    const membership = this.tenant.membership();
    // Only reachable if a route forgot @WorkspaceScoped(): fail closed.
    if (!membership) throw new Error('Workspace route without a verified membership');
    return membership;
  }
}
