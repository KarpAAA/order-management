import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsISO4217CurrencyCode,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CursorPageDto } from '@common/dto/cursor-page.dto';
import { NO_NUL_PATTERN, NoNulChar } from '@common/validation/no-nul-char.decorator';
import { WorkspaceRole } from '@shared/auth/workspace-role';

// ── input ───────────────────────────────────────────────────────────────────

export class RegisterDto {
  @ApiProperty({ format: 'email', maxLength: 254, example: 'ann@example.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 8, maxLength: 128, example: 'correct-horse-battery' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

export class LoginDto {
  @ApiProperty({ format: 'email', maxLength: 254, example: 'owner@acme.test' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 1, maxLength: 128, example: 'Passw0rd!' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password: string;
}

export class CreateWorkspaceDto {
  @ApiProperty({ minLength: 1, maxLength: 100, pattern: NO_NUL_PATTERN, example: 'Acme Inc.' })
  @IsString()
  @Length(1, 100)
  @NoNulChar()
  name: string;

  @ApiProperty({
    minLength: 3,
    maxLength: 50,
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
    example: 'acme',
  })
  @IsString()
  @Length(3, 50)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  slug: string;

  @ApiProperty({
    description: 'ISO 4217, upper case, fixed for the life of the workspace',
    example: 'EUR',
    pattern: '^[A-Z]{3}$',
  })
  // IsISO4217CurrencyCode ignores case; the column CHECK does not ('eur' was a 500)
  @Matches(/^[A-Z]{3}$/)
  @IsISO4217CurrencyCode()
  currency: string;

  @ApiProperty({ minimum: 0, maximum: 5000, type: 'integer', example: 2000 })
  @IsInt()
  @Min(0)
  @Max(5000)
  taxRateBps: number;
}

export class AddMemberDto {
  @ApiProperty({ format: 'email', maxLength: 254, description: 'An already registered user' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ enum: WorkspaceRole, enumName: 'WorkspaceRole' })
  @IsEnum(WorkspaceRole)
  role: WorkspaceRole;
}

// ── output ──────────────────────────────────────────────────────────────────

export class AccessTokenDto {
  @ApiProperty({ description: 'JWT access token (HS256). Send as `Authorization: Bearer …`' })
  accessToken: string;

  @ApiProperty({ type: 'integer', example: 900 })
  expiresIn: number;
}

export class WorkspaceDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiProperty({ example: 'EUR' }) currency: string;
  @ApiProperty({ type: 'integer', example: 2000 }) taxRateBps: number;
  @ApiProperty({ enum: WorkspaceRole, enumName: 'WorkspaceRole', description: 'Your role' })
  myRole: WorkspaceRole;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}

export class MyMembershipDto {
  @ApiProperty({ format: 'uuid' }) workspaceId: string;
  @ApiProperty() workspaceName: string;
  @ApiProperty() workspaceSlug: string;
  @ApiProperty({ enum: WorkspaceRole, enumName: 'WorkspaceRole' }) role: WorkspaceRole;
}

export class MeDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'email' }) email: string;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ type: [MyMembershipDto] }) memberships: MyMembershipDto[];
}

export class MemberDto {
  @ApiProperty({ format: 'uuid', description: 'Membership id' }) id: string;
  @ApiProperty({ format: 'uuid' }) userId: string;
  @ApiProperty({ format: 'email' }) email: string;
  @ApiProperty({ enum: WorkspaceRole, enumName: 'WorkspaceRole' }) role: WorkspaceRole;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}

export class WorkspacePageDto extends CursorPageDto(WorkspaceDto, 'WorkspacePageDto') {}
export class MemberPageDto extends CursorPageDto(MemberDto, 'MemberPageDto') {}
