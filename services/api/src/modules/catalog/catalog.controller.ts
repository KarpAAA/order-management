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
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

import { ApiErrors } from '@common/decorators/api-errors.decorator';
import { CurrentActor } from '@common/decorators/current-actor.decorator';
import { WorkspaceScoped } from '@common/decorators/workspace-scoped.decorator';
import { CreatedDto } from '@common/dto/common.dto';
import type { UserActor } from '@shared/auth/actor';

import {
  CreateProductDto,
  ListProductsQueryDto,
  ProductDto,
  ProductPageDto,
  UpdateProductDto,
} from './catalog.dto';
import { CatalogService } from './catalog.service';
import { CatalogQueryService } from './read/catalog.query.service';

@ApiTags('catalog')
@WorkspaceScoped()
@Controller('workspaces/:workspaceId/products')
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly query: CatalogQueryService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a product (ADMIN, OWNER)' })
  @ApiCreatedResponse({ type: CreatedDto })
  @ApiErrors(400, 409)
  createProduct(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Body() dto: CreateProductDto,
    @CurrentActor() actor: UserActor,
  ): Promise<CreatedDto> {
    return this.catalog.create(
      {
        workspaceId,
        sku: dto.sku,
        name: dto.name,
        description: dto.description ?? null,
        priceMinor: BigInt(dto.priceMinor),
      },
      actor,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List products, newest first (cursor pagination)' })
  @ApiOkResponse({ type: ProductPageDto })
  @ApiErrors(400)
  listProducts(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query() filter: ListProductsQueryDto,
  ): Promise<ProductPageDto> {
    return this.query.list(workspaceId, filter);
  }

  @Get(':productId')
  @ApiOperation({ summary: 'Product details' })
  @ApiOkResponse({ type: ProductDto })
  @ApiErrors(400)
  getProduct(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<ProductDto> {
    return this.query.get(workspaceId, productId);
  }

  @Patch(':productId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Update name, description or price (ADMIN, OWNER)' })
  @ApiNoContentResponse()
  @ApiErrors(400)
  async updateProduct(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: UpdateProductDto,
    @CurrentActor() actor: UserActor,
  ): Promise<void> {
    await this.catalog.update(
      {
        workspaceId,
        productId,
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.priceMinor !== undefined && { priceMinor: BigInt(dto.priceMinor) }),
      },
      actor,
    );
  }

  @Post(':productId/archive')
  @HttpCode(204)
  @ApiOperation({ summary: 'Archive a product (ADMIN, OWNER). Idempotent.' })
  @ApiNoContentResponse()
  @ApiErrors(400)
  async archiveProduct(
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('productId', ParseUUIDPipe) productId: string,
    @CurrentActor() actor: UserActor,
  ): Promise<void> {
    await this.catalog.archive({ workspaceId, productId }, actor);
  }
}
