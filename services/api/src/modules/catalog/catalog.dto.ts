import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CursorPageQueryDto, MoneyDto } from '@common/dto/common.dto';
import { CursorPageDto } from '@common/dto/cursor-page.dto';
import { IsOmittable } from '@common/validation/is-omittable.decorator';

import { ProductStatus } from './product-status';

export const MIN_PRICE_MINOR = 1;
export const MAX_PRICE_MINOR = 100_000_000;

// ── input ───────────────────────────────────────────────────────────────────

export class CreateProductDto {
  @ApiProperty({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$', example: 'MUG-001' })
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9._-]+$/)
  sku: string;

  @ApiProperty({ minLength: 1, maxLength: 200, example: 'Coffee mug' })
  @IsString()
  @Length(1, 200)
  name: string;

  @ApiPropertyOptional({ type: String, maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({
    type: 'integer',
    minimum: MIN_PRICE_MINOR,
    maximum: MAX_PRICE_MINOR,
    example: 1250,
    description: 'Minor units in the workspace currency',
  })
  @IsInt()
  @Min(MIN_PRICE_MINOR)
  @Max(MAX_PRICE_MINOR)
  priceMinor: number;
}

/** Hand-written: `sku` is immutable after creation (orders snapshot it). */
export class UpdateProductDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @IsOmittable()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 2000,
    nullable: true,
    description: '`null` clears it',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ type: 'integer', minimum: MIN_PRICE_MINOR, maximum: MAX_PRICE_MINOR })
  @IsOmittable()
  @IsInt()
  @Min(MIN_PRICE_MINOR)
  @Max(MAX_PRICE_MINOR)
  priceMinor?: number;
}

export class ListProductsQueryDto extends CursorPageQueryDto {
  @ApiPropertyOptional({ enum: ProductStatus, enumName: 'ProductStatus' })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}

// ── output ──────────────────────────────────────────────────────────────────

export class ProductDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() sku: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) description: string | null;
  @ApiProperty({ type: MoneyDto }) price: MoneyDto;
  @ApiProperty({ enum: ProductStatus, enumName: 'ProductStatus' }) status: ProductStatus;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt: Date;
}

export class ProductPageDto extends CursorPageDto(ProductDto, 'ProductPageDto') {}
