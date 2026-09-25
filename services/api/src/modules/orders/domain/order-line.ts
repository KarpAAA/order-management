import { newId } from '@shared/domain/id';
import type { Money } from '@shared/domain/money';

import { InvalidOrderError } from './errors';
import { lineTotal } from './order-totals';

export const MIN_QUANTITY = 1;
export const MAX_QUANTITY = 1000;

export interface OrderLineProps {
  id: string;
  position: number;
  productId: string;
  /** Snapshots taken when the line was added: later catalog changes never touch the order. */
  sku: string;
  name: string;
  unitPrice: Money;
  quantity: number;
}

/** Internal entity of `Order`. Immutable: editing an order replaces its lines. */
export class OrderLine {
  private constructor(private readonly props: OrderLineProps) {}

  /** Called by `Order` only. */
  static create(input: Omit<OrderLineProps, 'id'>): OrderLine {
    const { quantity } = input;
    if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
      throw new InvalidOrderError('quantity must be within 1..1000', {
        productId: input.productId,
        quantity,
      });
    }
    return new OrderLine({ ...input, id: newId() });
  }

  static restore(props: OrderLineProps): OrderLine {
    return new OrderLine(props);
  }

  get id(): string {
    return this.props.id;
  }
  get productId(): string {
    return this.props.productId;
  }
  get quantity(): number {
    return this.props.quantity;
  }
  get unitPrice(): Money {
    return this.props.unitPrice;
  }
  get total(): Money {
    return lineTotal(this.props.unitPrice, this.props.quantity);
  }

  snapshot(): Readonly<OrderLineProps> {
    return { ...this.props };
  }
}
