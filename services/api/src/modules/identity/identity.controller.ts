import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ApiErrors } from '@common/decorators/api-errors.decorator';
import { CurrentActor } from '@common/decorators/current-actor.decorator';
import { Public } from '@common/decorators/public.decorator';
import { WorkspaceScoped } from '@common/decorators/workspace-scoped.decorator';
import { CreatedDto, CursorPageQueryDto } from '@common/dto/common.dto';
import type { UserActor } from '@shared/auth/actor';

import {
  AccessTokenDto,
  AddMemberDto,
  CreateWorkspaceDto,
  LoginDto,
  MeDto,
  MemberPageDto,
  RegisterDto,
  WorkspaceDto,
  WorkspacePageDto,
} from './identity.dto';
import { IdentityService } from './identity.service';
import { IdentityQueryService } from './read/identity.query.service';

@ApiTags('identity')
@Controller()
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly query: IdentityQueryService,
  ) {}

  // ── auth ──────────────────────────────────────────────────────────────────

  @Public()
  @Post('auth/register')
  @HttpCode(201)
  @ApiOperation({ summary: 'Register a user (email + password)' })
  @ApiCreatedResponse({ type: CreatedDto })
  @ApiErrors(400, 409)
  register(@Body() dto: RegisterDto): Promise<CreatedDto> {
    return this.identity.register({ email: dto.email, password: dto.password });
  }

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange credentials for an access token' })
  @ApiOkResponse({ type: AccessTokenDto })
  @ApiErrors(400, 401)
  login(@Body() dto: LoginDto): Promise<AccessTokenDto> {
    return this.identity.login({ email: dto.email, password: dto.password });
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'The current user and their memberships' })
  @ApiOkResponse({ type: MeDto })
  @ApiErrors(401, 404)
  me(@CurrentActor() actor: UserActor): Promise<MeDto> {
    return this.query.me(actor);
  }

  // ── workspaces ────────────────────────────────────────────────────────────

  @Post('workspaces')
  @HttpCode(201)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a workspace; the caller becomes its OWNER' })
  @ApiCreatedResponse({ type: CreatedDto })
  @ApiErrors(400, 401, 409)
  createWorkspace(
    @Body() dto: CreateWorkspaceDto,
    @CurrentActor() actor: UserActor,
  ): Promise<CreatedDto> {
    return this.identity.createWorkspace(
      { name: dto.name, slug: dto.slug, currency: dto.currency, taxRateBps: dto.taxRateBps },
      actor,
    );
  }

  @Get('workspaces')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Workspaces the caller is a member of' })
  @ApiOkResponse({ type: WorkspacePageDto })
  @ApiErrors(400, 401)
  listMyWorkspaces(
    @Query() page: CursorPageQueryDto,
    @CurrentActor() actor: UserActor,
  ): Promise<WorkspacePageDto> {
    return this.query.listMyWorkspaces(actor, page);
  }

  @Get('workspaces/:workspaceId')
  @WorkspaceScoped()
  @ApiOperation({ summary: 'Workspace details and the caller role' })
  @ApiOkResponse({ type: WorkspaceDto })
  getWorkspace(@Param('workspaceId', ParseUUIDPipe) workspaceId: string): Promise<WorkspaceDto> {
    return this.query.getWorkspace(workspaceId);
  }

  @Get('workspaces/:workspaceId/members')
  @WorkspaceScoped()
  @ApiOperation({ summary: 'Members of the workspace' })
  @ApiOkResponse({ type: MemberPageDto })
  @ApiErrors(400)
  listMembers(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Query() page: CursorPageQueryDto,
  ): Promise<MemberPageDto> {
    return this.query.listMembers(page);
  }

  @Post('workspaces/:workspaceId/members')
  @HttpCode(201)
  @WorkspaceScoped()
  @ApiOperation({
    summary: 'Add a registered user to the workspace',
    description: 'ADMIN may grant MEMBER or VIEWER; only OWNER may grant ADMIN or OWNER.',
  })
  @ApiCreatedResponse({ type: CreatedDto })
  @ApiErrors(400, 409)
  addMember(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: AddMemberDto,
    @CurrentActor() actor: UserActor,
  ): Promise<CreatedDto> {
    return this.identity.addMember({ workspaceId, email: dto.email, role: dto.role }, actor);
  }
}
