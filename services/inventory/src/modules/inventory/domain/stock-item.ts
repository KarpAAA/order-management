import {
  InsufficientStockError,
  InvalidQuantityError,
  StockBelowReservedError,
  StockNotHeldError,
} from './errors';

export interface StockItemProps {
  workspaceId: string;
  productId: string;
  /** Physically there, held or not. */
  onHand: number;
  /** Held by reservations. */
  reserved: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The stock of one product: what is there and what of it is promised to orders. The one
 * invariant, `0 <= reserved <= onHand`, holds after every method. No version: whoever
 * changes a stock item has locked its row first (ports/stock-repository.port.ts).
 */
export class StockItem {
  private constructor(private readonly props: StockItemProps) {}

  /** A product the service hears of for the first time: nothing on hand yet. */
  static open(input: { workspaceId: string; productId: string; now: Date }): StockItem {
    return new StockItem({
      workspaceId: input.workspaceId,
      productId: input.productId,
      onHand: 0,
      reserved: 0,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: StockItemProps): StockItem {
    return new StockItem(props);
  }

  reserve(quantity: number, now: Date): void {
    this.assertUnits(quantity);
    if (quantity > this.available) {
      throw new InsufficientStockError(this.productId, quantity, this.available);
    }
    this.props.reserved += quantity;
    this.props.updatedAt = now;
  }

  /** Gives back what a reservation held. */
  release(quantity: number, now: Date): void {
    this.assertUnits(quantity);
    if (quantity > this.props.reserved) {
      throw new StockNotHeldError(this.productId, quantity, this.props.reserved);
    }
    this.props.reserved -= quantity;
    this.props.updatedAt = now;
  }

  /** Units arrived (positive) or left (negative). What is held cannot leave. */
  adjust(delta: number, now: Date): void {
    this.assertUnits(Math.abs(delta));
    const onHand = this.props.onHand + delta;
    if (onHand < this.props.reserved) {
      throw new StockBelowReservedError(this.productId, onHand, this.props.reserved);
    }
    this.props.onHand = onHand;
    this.props.updatedAt = now;
  }

  get workspaceId(): string {
    return this.props.workspaceId;
  }
  get productId(): string {
    return this.props.productId;
  }
  get onHand(): number {
    return this.props.onHand;
  }
  get reserved(): number {
    return this.props.reserved;
  }
  /** Free to be reserved. */
  get available(): number {
    return this.props.onHand - this.props.reserved;
  }

  snapshot(): Readonly<StockItemProps> {
    return { ...this.props };
  }

  private assertUnits(quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new InvalidQuantityError(this.productId, quantity);
    }
  }
}
