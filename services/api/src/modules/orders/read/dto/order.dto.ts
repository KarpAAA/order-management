import { ApiProperty } from '@nestjs/swagger';

import { MoneyDto } from '@common/dto/common.dto';
import { CursorPageDto } from '@common/dto/cursor-page.dto';

import { DiscountType } from '../../domain/discount';
import { OrderEventType, OrderStatus } from '../../domain/order-status';

export class OrderItemDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) productId: string;
  @ApiProperty({ description: 'Snapshot at the time the item was added' }) sku: string;
  @ApiProperty({ description: 'Snapshot at the time the item was added' }) name: string;
  @ApiProperty({ type: MoneyDto }) unitPrice: MoneyDto;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 1000 }) quantity: number;
  @ApiProperty({ type: MoneyDto }) lineTotal: MoneyDto;
}

export class OrderDiscountDto {
  @ApiProperty({ enum: DiscountType, enumName: 'DiscountType' }) type: DiscountType;

  @ApiProperty({ type: 'integer', nullable: true, description: 'PERCENT only; 10000 = 100 %' })
  valueBps: number | null;

  @ApiProperty({ type: MoneyDto, nullable: true, description: 'FIXED only' })
  value: MoneyDto | null;
}

export class OrderTotalsDto {
  @ApiProperty({ type: MoneyDto }) subtotal: MoneyDto;
  @ApiProperty({ type: MoneyDto }) discount: MoneyDto;
  @ApiProperty({ type: MoneyDto }) tax: MoneyDto;
  @ApiProperty({ type: MoneyDto }) total: MoneyDto;
}

export class OrderDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' }) status: OrderStatus;
  @ApiProperty({ example: 'EUR' }) currency: string;
  @ApiProperty({ type: [OrderItemDto] }) items: OrderItemDto[];
  @ApiProperty({ type: OrderDiscountDto }) discount: OrderDiscountDto;
  @ApiProperty({ type: 'integer', description: 'Snapshot of the workspace rate at creation' })
  taxRateBps: number;
  @ApiProperty({ type: OrderTotalsDto }) totals: OrderTotalsDto;
  @ApiProperty({ type: 'integer', description: 'Incremented by every place' })
  paymentAttempt: number;
  @ApiProperty({ type: String, nullable: true }) pspChargeId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'insufficient_funds' })
  failureReason: string | null;
  @ApiProperty({ type: 'integer', description: 'Send back on PATCH and actions (optimistic lock)' })
  version: number;
  @ApiProperty({ format: 'uuid' }) createdBy: string;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) placedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) paidAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) fulfilledAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) cancelledAt: Date | null;
}

export class OrderSummaryDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' }) status: OrderStatus;
  @ApiProperty({ type: MoneyDto }) total: MoneyDto;
  @ApiProperty({ type: 'integer' }) paymentAttempt: number;
  @ApiProperty({ type: 'integer' }) version: number;
  @ApiProperty({ format: 'uuid' }) createdBy: string;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt: Date;
}

export class OrderEventDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: OrderEventType, enumName: 'OrderEventType' }) type: OrderEventType;
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus', nullable: true })
  fromStatus: OrderStatus | null;
  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' }) toStatus: OrderStatus;
  @ApiProperty({ description: 'User id, or `system:<source>` (e.g. `system:consumer:orders`)' })
  actor: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { paymentAttempt: 1 },
    description: 'Event-specific data (payment attempt, charge id, failure reason)',
  })
  payload: Record<string, unknown>;
  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}

export class OrderPageDto extends CursorPageDto(OrderSummaryDto, 'OrderPageDto') {}
export class OrderEventPageDto extends CursorPageDto(OrderEventDto, 'OrderEventPageDto') {}

export class OrderAcceptedDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: [OrderStatus.PendingPayment], example: OrderStatus.PendingPayment })
  status: OrderStatus.PendingPayment;
}
