import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ValidationFieldErrorDto {
  @ApiProperty({ example: 'items.0.quantity', description: 'Dot path with array indices' })
  path: string;

  @ApiProperty({ example: 'max', description: 'class-validator constraint name' })
  code: string;

  @ApiProperty({ example: 'quantity must not be greater than 1000' })
  message: string;
}

/** The single error shape for every non-2xx response (http/error-handling.md §3). */
export class ErrorResponseDto {
  @ApiProperty({
    example: 'ORDER_INVALID_TRANSITION',
    description: 'Stable, SCREAMING_SNAKE. Clients branch on this, never on `message`.',
  })
  code: string;

  @ApiProperty({ example: 'Order 0199… cannot cancel from PENDING_PAYMENT' })
  message: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Error-specific data. For VALIDATION_FAILED: `{ fields: ValidationFieldError[] }`. Absent on 403 and 5xx.',
  })
  details?: Record<string, unknown>;
}
