import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ApiErrors } from '@common/decorators/api-errors.decorator';
import { CurrentActor } from '@common/decorators/current-actor.decorator';
import { WorkspaceScoped } from '@common/decorators/workspace-scoped.decorator';
import { CreatedDto, CursorPageQueryDto, VersionDto } from '@common/dto/common.dto';
import type { UserActor } from '@shared/auth/actor';

import { CancelOrderService } from '../../application/cancel-order.service';
import { CreateOrderService } from '../../application/create-order.service';
import { FulfillOrderService } from '../../application/fulfill-order.service';
import { PlaceOrderService } from '../../application/place-order.service';
import { UpdateOrderService } from '../../application/update-order.service';
import { OrderStatus } from '../../domain/order-status';
import {
  OrderAcceptedDto,
  OrderDto,
  OrderEventPageDto,
  OrderPageDto,
} from '../../read/dto/order.dto';
import { OrdersQueryService } from '../../read/orders.query.service';

import {
  CreateOrderDto,
  ListOrdersQueryDto,
  toDiscountInput,
  UpdateOrderDto,
} from './dto/order-input.dto';

@ApiTags('orders')
@WorkspaceScoped()
@Controller('workspaces/:workspaceId/orders')
export class OrdersController {
  constructor(
    private readonly createOrderService: CreateOrderService,
    private readonly updateOrderService: UpdateOrderService,
    private readonly placeOrderService: PlaceOrderService,
    private readonly cancelOrderService: CancelOrderService,
    private readonly fulfillOrderService: FulfillOrderService,
    private readonly query: OrdersQueryService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a DRAFT order (MEMBER and above)' })
  @ApiCreatedResponse({ type: CreatedDto })
  @ApiErrors(400, 422)
  createOrder(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateOrderDto,
    @CurrentActor() actor: UserActor,
  ): Promise<CreatedDto> {
    return this.createOrderService.execute(
      {
        workspaceId,
        items: dto.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        ...(dto.discount && { discount: toDiscountInput(dto.discount) }),
      },
      actor,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List orders, newest first (cursor pagination)' })
  @ApiOkResponse({ type: OrderPageDto })
  @ApiErrors(400)
  listOrders(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Query() filter: ListOrdersQueryDto,
  ): Promise<OrderPageDto> {
    return this.query.list(filter);
  }

  @Get(':orderId')
  @ApiOperation({
    summary: 'Order details; poll this after place until status leaves PENDING_PAYMENT',
  })
  @ApiOkResponse({ type: OrderDto })
  @ApiErrors(400)
  getOrder(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ): Promise<OrderDto> {
    return this.query.get(orderId);
  }

  @Patch(':orderId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Replace items and discount of a DRAFT order (MEMBER and above)' })
  @ApiNoContentResponse()
  @ApiErrors(400, 409, 422)
  async updateOrder(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateOrderDto,
    @CurrentActor() actor: UserActor,
  ): Promise<void> {
    await this.updateOrderService.execute(
      {
        orderId,
        version: dto.version,
        items: dto.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        discount: toDiscountInput(dto.discount),
      },
      actor,
    );
  }

  @Post(':orderId/place')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Place the order: charge runs asynchronously (MEMBER and above)',
    description:
      'DRAFT or PAYMENT_FAILED → PENDING_PAYMENT with a new payment attempt. ' +
      'Poll GET /orders/{orderId} until the status becomes PAID or PAYMENT_FAILED.',
  })
  @ApiAcceptedResponse({ type: OrderAcceptedDto })
  @ApiErrors(400, 409, 422)
  async placeOrder(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: VersionDto,
    @CurrentActor() actor: UserActor,
  ): Promise<OrderAcceptedDto> {
    await this.placeOrderService.execute({ orderId, version: dto.version }, actor);
    return { id: orderId, status: OrderStatus.PendingPayment };
  }

  @Post(':orderId/cancel')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Cancel a DRAFT or PAYMENT_FAILED order (MEMBER and above)',
    description: 'PENDING_PAYMENT cannot be cancelled in Step 0 (422): it races with the charge.',
  })
  @ApiNoContentResponse()
  @ApiErrors(400, 409, 422)
  async cancelOrder(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: VersionDto,
    @CurrentActor() actor: UserActor,
  ): Promise<void> {
    await this.cancelOrderService.execute({ orderId, version: dto.version }, actor);
  }

  @Post(':orderId/fulfill')
  @HttpCode(204)
  @ApiOperation({ summary: 'Fulfill a PAID order (ADMIN, OWNER)' })
  @ApiNoContentResponse()
  @ApiErrors(400, 409, 422)
  async fulfillOrder(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: VersionDto,
    @CurrentActor() actor: UserActor,
  ): Promise<void> {
    await this.fulfillOrderService.execute({ orderId, version: dto.version }, actor);
  }

  @Get(':orderId/events')
  @ApiOperation({ summary: 'Order history: one entry per status change, oldest first' })
  @ApiOkResponse({ type: OrderEventPageDto })
  @ApiErrors(400)
  listOrderEvents(
    @Param('workspaceId', ParseUUIDPipe) _workspaceId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Query() page: CursorPageQueryDto,
  ): Promise<OrderEventPageDto> {
    return this.query.listEvents(orderId, page);
  }
}
