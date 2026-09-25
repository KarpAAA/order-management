import { ApiProperty } from '@nestjs/swagger';

import type { Type } from '@nestjs/common';

/**
 * Swagger class for `PaginatedByCursor<TItem>`. OpenAPI has no generics, so each list gets
 * a named schema: `CursorPageDto(ProductDto, 'ProductPageDto')`.
 */
export function CursorPageDto<TItem>(item: Type<TItem>, name: string) {
  class Page {
    @ApiProperty({ type: [item] })
    items: TItem[];

    @ApiProperty({
      type: String,
      nullable: true,
      description: 'Pass as `cursor` to get the next page; `null` on the last page',
    })
    nextCursor: string | null;
  }
  Object.defineProperty(Page, 'name', { value: name });
  return Page;
}
