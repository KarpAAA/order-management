import type { RequestedItem } from './order-inputs.reader';
import type { DiscountType } from '../domain/discount';
import type { StockShortage } from '../domain/order';
import type { WaitingStep } from '../domain/order-saga-step';

/** Use case inputs. Plain objects built by the controller or the consumer from their DTOs. */

export interface DiscountInput {
  type: DiscountType;
  valueBps?: number;
  valueMinor?: bigint;
}

export interface CreateOrderCommand {
  workspaceId: string;
  items: RequestedItem[];
  discount?: DiscountInput;
}

export interface UpdateOrderCommand {
  orderId: string;
  version: number;
  items: RequestedItem[];
  discount: DiscountInput;
}

/** place, cancel, fulfill: the order and the version the client saw. */
export interface OrderActionCommand {
  orderId: string;
  version: number;
}

export interface CompleteOrderPaymentCommand {
  orderId: string;
  paymentAttempt: number;
  pspChargeId: string;
}

export interface FailOrderPaymentCommand {
  orderId: string;
  paymentAttempt: number;
  reason: string;
}

/** An answer of inventory about the reservation of one placing of the order. */
export interface StockAnswerCommand {
  orderId: string;
  attempt: number;
}

export interface RejectStockReservationCommand extends StockAnswerCommand {
  shortages: readonly StockShortage[];
}

export interface ExpireSagaStepCommand {
  orderId: string;
  attempt: number;
  /** The step the timeout was written for. */
  step: WaitingStep;
}

export interface MaintainOrderEventPartitionsCommand {
  /** Partitions kept ready after the current month. */
  monthsAhead: number;
  /** Full months of history kept besides the current one; 0 keeps everything. */
  retentionMonths: number;
}
