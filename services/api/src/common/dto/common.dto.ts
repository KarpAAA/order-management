import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** `201 { id }` body of every create endpoint. */
export class CreatedDto {
  @ApiProperty({ format: 'uuid' })
  id: string;
}

/** Money at the JSON edge: BigInt minor units as a safe-integer number + ISO 4217 code. */
export class MoneyDto {
  @ApiProperty({ example: 1250, description: 'Minor units (cents)', type: 'integer' })
  amountMinor: number;

  @ApiProperty({ example: 'EUR', pattern: '^[A-Z]{3}$', minLength: 3, maxLength: 3 })
  currency: string;
}

/** Keyset pagination input. `cursor` is opaque: pass back `nextCursor` unchanged. */
export class CursorPageQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20, type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

/** Body of every L4 action (`place`, `cancel`, `fulfill`): the version the client saw. */
export class VersionDto {
  @ApiProperty({ minimum: 0, type: 'integer', example: 0 })
  @IsInt()
  @Min(0)
  version: number;
}

/** Converts BigInt minor units to a JSON number, refusing silent precision loss. */
export function toMoneyDto(amountMinor: bigint, currency: string): MoneyDto {
  const value = Number(amountMinor);
  if (!Number.isSafeInteger(value)) throw new RangeError(`Amount ${amountMinor} exceeds 2^53`);
  return { amountMinor: value, currency };
}
