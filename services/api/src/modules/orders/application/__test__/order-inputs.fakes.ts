import type { CatalogFacade, ProductSnapshot } from '@modules/catalog';
import type { IdentityFacade, WorkspaceTerms } from '@modules/identity';

import { CURRENCY, PRODUCT_1, PRODUCT_2, TAX_RATE_BPS } from '../../domain/__test__/builders';
import { OrderInputsReader } from '../order-inputs.reader';

export const ACTIVE_PRODUCT: ProductSnapshot = {
  id: PRODUCT_1,
  sku: 'SKU-1',
  name: 'Product 1',
  priceMinor: 1250n,
  isActive: true,
};

export const ARCHIVED_PRODUCT: ProductSnapshot = {
  id: PRODUCT_2,
  sku: 'SKU-2',
  name: 'Product 2',
  priceMinor: 990n,
  isActive: false,
};

export const TERMS: WorkspaceTerms = { currency: CURRENCY, taxRateBps: TAX_RATE_BPS };

/** Fake of the catalog facade: returns the known products among the requested ids. */
export class FakeCatalog {
  /** Every id list the reader asked for, to assert how it queried. */
  readonly requests: (readonly string[])[] = [];

  constructor(private readonly products: readonly ProductSnapshot[]) {}

  findProductSnapshots(productIds: readonly string[]): Promise<ProductSnapshot[]> {
    this.requests.push(productIds);
    return Promise.resolve(this.products.filter((product) => productIds.includes(product.id)));
  }
}

/** Fake of the identity facade: every workspace has the same terms. */
export const fakeIdentity = (terms: WorkspaceTerms = TERMS): IdentityFacade =>
  ({ getWorkspaceTerms: () => Promise.resolve(terms) }) as unknown as IdentityFacade;

/** The real reader over fake facades (only the methods it calls exist). */
export const readerOver = (
  catalog: FakeCatalog = new FakeCatalog([ACTIVE_PRODUCT, ARCHIVED_PRODUCT]),
  identity: IdentityFacade = fakeIdentity(),
): OrderInputsReader => new OrderInputsReader(catalog as unknown as CatalogFacade, identity);
