import type { RequestedLine } from '../domain/allocation';

/** What every command carries from its envelope. */
interface FromEnvelope {
  /** The tenant: stock and reservations of another workspace are out of reach. */
  workspaceId: string;
  /** Carried into the answer. */
  correlationId: string;
}

export interface ReserveStockCommand extends FromEnvelope {
  orderId: string;
  attempt: number;
  lines: readonly RequestedLine[];
}

export interface ReleaseStockCommand extends FromEnvelope {
  orderId: string;
  attempt: number;
}

export interface AdjustStockCommand extends FromEnvelope {
  productId: string;
  delta: number;
}
