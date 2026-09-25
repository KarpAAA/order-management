import { ConflictError, NotFoundError } from '@shared/errors/domain-error';

export class ProductNotFoundError extends NotFoundError {
  readonly code = 'PRODUCT_NOT_FOUND';

  constructor(productId: string) {
    super(`Product ${productId} not found`, { productId });
  }
}

export class SkuTakenError extends ConflictError {
  readonly code = 'PRODUCT_SKU_TAKEN';

  constructor(sku: string) {
    super(`SKU "${sku}" is already used in this workspace`, { sku });
  }
}
