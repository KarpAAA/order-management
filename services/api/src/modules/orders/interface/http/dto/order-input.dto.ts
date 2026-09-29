import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { CursorPageQueryDto, VersionDto } from '@common/dto/common.dto';
import { IsOmittable } from '@common/validation/is-omittable.decorator';

import { DiscountType, MAX_PERCENT_BPS } from '../../../domain/discount';
import { MAX_LINES } from '../../../domain/order';
import { MAX_QUANTITY, MIN_QUANTITY } from '../../../domain/order-line';
import { OrderStatus } from '../../../domain/order-status';

import type { DiscountInput } from '../../../application/order-commands';

export class OrderItemInputDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId: string;

  @ApiProperty({ type: 'integer', minimum: MIN_QUANTITY, maximum: MAX_QUANTITY, example: 2 })
  @IsInt()
  @Min(MIN_QUANTITY)
  @Max(MAX_QUANTITY)
  quantity: number;
}

/**
 * `valueBps` goes with PERCENT, `valueMinor` with FIXED, neither with NONE. Validated as one
 * class; wrong combinations are rejected by the domain (`INVALID_ORDER`). The OpenAPI
 * document describes the same rule as three variants (`discountSchema` below).
 */
export class DiscountInputDto {
  @IsEnum(DiscountType)
  type: DiscountType;

  @ValidateIf((o: DiscountInputDto) => o.type === DiscountType.Percent || o.valueBps !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_PERCENT_BPS)
  valueBps?: number;

  @ValidateIf((o: DiscountInputDto) => o.type === DiscountType.Fixed || o.valueMinor !== undefined)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  valueMinor?: number;
}

// OpenAPI only: one schema per discount type, so a client sees which fields go with which type.
export class DiscountNoneDto {
  @ApiProperty({ enum: [DiscountType.None] })
  type: DiscountType.None;
}

export class DiscountPercentDto {
  @ApiProperty({ enum: [DiscountType.Percent] })
  type: DiscountType.Percent;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: MAX_PERCENT_BPS,
    description: '10000 = 100 %',
  })
  valueBps: number;
}

export class DiscountFixedDto {
  @ApiProperty({ enum: [DiscountType.Fixed] })
  type: DiscountType.Fixed;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'Minor units, capped at the subtotal',
  })
  valueMinor: number;
}

/** Register with `@ApiExtraModels(...DISCOUNT_SCHEMA_MODELS)` on the controller. */
export const DISCOUNT_SCHEMA_MODELS = [DiscountNoneDto, DiscountPercentDto, DiscountFixedDto];

const discountSchema = {
  // explicit, or Nest adds `allOf: [DiscountInputDto]` from the TypeScript type
  type: Object,
  oneOf: DISCOUNT_SCHEMA_MODELS.map((model) => ({ $ref: getSchemaPath(model) })),
  discriminator: {
    propertyName: 'type',
    mapping: {
      [DiscountType.None]: getSchemaPath(DiscountNoneDto),
      [DiscountType.Percent]: getSchemaPath(DiscountPercentDto),
      [DiscountType.Fixed]: getSchemaPath(DiscountFixedDto),
    },
  },
};

export class CreateOrderDto {
  @ApiProperty({
    type: [OrderItemInputDto],
    maxItems: MAX_LINES,
    description: 'May be empty while the order is a draft; placing needs at least one item',
  })
  @IsArray()
  @ArrayMaxSize(MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items: OrderItemInputDto[];

  @ApiPropertyOptional(discountSchema)
  @IsOmittable()
  @ValidateNested()
  @Type(() => DiscountInputDto)
  discount?: DiscountInputDto;
}

/** Replaces items and discount; both are required so the result is never ambiguous. */
export class UpdateOrderDto extends VersionDto {
  @ApiProperty({ type: [OrderItemInputDto], maxItems: MAX_LINES })
  @IsArray()
  @ArrayMaxSize(MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items: OrderItemInputDto[];

  @ApiProperty(discountSchema)
  @IsDefined() // @ValidateNested() alone lets a missing object through
  @ValidateNested()
  @Type(() => DiscountInputDto)
  discount: DiscountInputDto;
}

export class ListOrdersQueryDto extends CursorPageQueryDto {
  @ApiPropertyOptional({ enum: OrderStatus, enumName: 'OrderStatus' })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;
}

export const toDiscountInput = (dto: DiscountInputDto): DiscountInput => ({
  type: dto.type,
  ...(dto.valueBps !== undefined && { valueBps: dto.valueBps }),
  ...(dto.valueMinor !== undefined && { valueMinor: BigInt(dto.valueMinor) }),
});
