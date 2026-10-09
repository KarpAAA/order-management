/** Mirrors the Prisma enum `ReservationStatus` one-to-one. */
export enum ReservationStatus {
  /** Every line is held. */
  Reserved = 'RESERVED',
  /** A line fell short: nothing is held, and nothing will be. */
  Rejected = 'REJECTED',
  /** What was held is given back; also a reservation released before it was asked for. */
  Released = 'RELEASED',
}
