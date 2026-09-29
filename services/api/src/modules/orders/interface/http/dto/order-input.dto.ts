import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

/** `valueBps` goes with PERCENT, `valueMinor` with FIXED, neither with NONE. */
export class DiscountInputDto {
  @ApiProperty({ enum: DiscountType, enumName: 'DiscountType' })
  @IsEnum(DiscountType)
  type: DiscountType;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: MAX_PERCENT_BPS,
    description: 'Required for PERCENT; 10000 = 100 %',
  })
  @ValidateIf((o: DiscountInputDto) => o.type === DiscountType.Percent || o.valueBps !== undefined)
  @IsInt()
  @Min(0)
  @Max(MAX_PERCENT_BPS)
  valueBps?: number;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'Required for FIXED; minor units, capped at the subtotal',
  })
  @ValidateIf((o: DiscountInputDto) => o.type === DiscountType.Fixed || o.valueMinor !== undefined)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  valueMinor?: number;
}

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

  @ApiPropertyOptional({ type: DiscountInputDto })
  @IsOptional()
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

  @ApiProperty({ type: DiscountInputDto })
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
