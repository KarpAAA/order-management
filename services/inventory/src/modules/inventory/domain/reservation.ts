import { newId } from '@shared/domain/id';

import { ReservationNotHeldError } from './errors';
import { ReservationStatus } from './reservation-status';

export interface ReservationLine {
  productId: string;
  quantity: number;
  /** REJECTED only, and only on a line that fell short: what was free then. */
  available: number | null;
}

/** A line of a rejected reservation that could not be held. */
export interface Shortage {
  productId: string;
  requested: number;
  available: number;
}

export interface ReservationProps {
  id: string;
  workspaceId: string;
  orderId: string;
  /** Which placing of the order. One reservation per (order, attempt), ever. */
  attempt: number;
  status: ReservationStatus;
  lines: ReservationLine[];
  version: number;
  createdAt: Date;
  releasedAt: Date | null;
}

interface Attempt {
  workspaceId: string;
  orderId: string;
  attempt: number;
  now: Date;
}

/**
 * What one attempt of an order holds, every line or none. It is born in one of three states
 * and changes once at most:
 *
 *   (new) → RESERVED → RELEASED
 *   (new) → REJECTED
 *   (new) → RELEASED            released before it was asked for
 *
 * The last one is what keeps a late `reserve` from holding stock for an order that has
 * already let go: the commands of one attempt may arrive in either order.
 */
export class Reservation {
  private constructor(private readonly props: ReservationProps) {}

  /** Every line is held. Called by `allocate()`, which has reserved the stock. */
  static hold(input: Attempt & { lines: readonly { productId: string; quantity: number }[] }) {
    const lines = input.lines.map((line) => ({ ...line, available: null }));
    return Reservation.born(input, ReservationStatus.Reserved, lines);
  }

  /** At least one line fell short: nothing is held. The lines say which, and by how much. */
  static reject(input: Attempt & { lines: readonly ReservationLine[] }): Reservation {
    return Reservation.born(input, ReservationStatus.Rejected, [...input.lines]);
  }

  /** The release came first: the attempt holds nothing, and never will. */
  static releaseAhead(input: Attempt): Reservation {
    const reservation = Reservation.born(input, ReservationStatus.Released, []);
    reservation.props.releasedAt = input.now;
    return reservation;
  }

  static restore(props: ReservationProps): Reservation {
    return new Reservation(props);
  }

  private static born(
    input: Attempt,
    status: ReservationStatus,
    lines: ReservationLine[],
  ): Reservation {
    return new Reservation({
      id: newId(),
      workspaceId: input.workspaceId,
      orderId: input.orderId,
      attempt: input.attempt,
      status,
      lines,
      version: 0,
      createdAt: input.now,
      releasedAt: null,
    });
  }

  /** RESERVED → RELEASED. The caller gives the lines back to the stock. */
  release(now: Date): void {
    if (!this.holdsStock) throw new ReservationNotHeldError(this.id, this.props.status);
    this.props.status = ReservationStatus.Released;
    this.props.releasedAt = now;
  }

  get id(): string {
    return this.props.id;
  }
  get workspaceId(): string {
    return this.props.workspaceId;
  }
  get orderId(): string {
    return this.props.orderId;
  }
  get attempt(): number {
    return this.props.attempt;
  }
  get status(): ReservationStatus {
    return this.props.status;
  }
  get version(): number {
    return this.props.version;
  }
  get lines(): readonly Readonly<ReservationLine>[] {
    return this.props.lines;
  }
  get holdsStock(): boolean {
    return this.props.status === ReservationStatus.Reserved;
  }
  /** Why it was rejected; empty in every other state. */
  get shortages(): Shortage[] {
    return this.props.lines.flatMap(({ productId, quantity, available }) =>
      available === null ? [] : [{ productId, requested: quantity, available }],
    );
  }

  snapshot(): Readonly<ReservationProps> {
    return { ...this.props, lines: this.props.lines.map((line) => ({ ...line })) };
  }
}
