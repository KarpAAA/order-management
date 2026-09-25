import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiParam } from '@nestjs/swagger';

import { WorkspaceAccessGuard } from '../guards/workspace-access.guard';

import { ApiErrors } from './api-errors.decorator';

/**
 * Class decorator for every controller under `/workspaces/:workspaceId/…`: membership
 * check (404 for non-members), tenant context, and the matching OpenAPI surface.
 * The host module must provide `MEMBERSHIP_READER` (import `IdentityModule`).
 */
export const WorkspaceScoped = () =>
  applyDecorators(
    UseGuards(WorkspaceAccessGuard),
    ApiBearerAuth(),
    ApiParam({ name: 'workspaceId', format: 'uuid', description: 'Workspace (tenant) id' }),
    ApiErrors(401, 403, 404),
  );
