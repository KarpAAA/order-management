/**
 * An amount in minor units with its ISO 4217 currency. The service never computes with money:
 * it charges the amount it was asked to charge, so there is no arithmetic here.
 */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}
