import { DomainError } from '../errors/domain-error';

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(left: string, right: string) {
    super(`Cannot combine ${left} with ${right}`, { left, right });
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

const CURRENCY = /^[A-Z]{3}$/;
const BPS_DENOMINATOR = 10_000n;

/**
 * Integer division rounding half away from zero — "round half up" for the non-negative
 * amounts this system deals with. `roundHalfUp(5n, 2n) === 3n`.
 */
export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new InvalidMoneyError('Denominator must be positive', {});
  // Stryker disable next-line EqualityOperator: `<=` flips the sign of 0 only, and -0n === 0n
  const sign = numerator < 0n ? -1n : 1n;
  // Stryker disable next-line ArithmeticOperator: sign is ±1, so `/ sign` equals `* sign`
  const abs = numerator * sign;
  return sign * ((abs * 2n + denominator) / (denominator * 2n));
}

/** Money as BigInt minor units + ISO 4217 currency. All arithmetic stays inside. */
export class Money {
  private constructor(
    readonly amountMinor: bigint,
    readonly currency: string,
  ) {}

  static of(amountMinor: bigint, currency: string): Money {
    if (!CURRENCY.test(currency)) {
      throw new InvalidMoneyError('Currency must be an ISO 4217 code', { currency });
    }
    return new Money(amountMinor, currency);
  }

  static zero(currency: string): Money {
    return Money.of(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor - other.amountMinor, this.currency);
  }

  multiply(factor: number): Money {
    if (!Number.isSafeInteger(factor)) {
      throw new InvalidMoneyError('Factor must be an integer', { factor });
    }
    return new Money(this.amountMinor * BigInt(factor), this.currency);
  }

  /** `bps` basis points of this amount, rounded half up: 10 000 bps = 100 %. */
  basisPoints(bps: number): Money {
    if (!Number.isSafeInteger(bps)) throw new InvalidMoneyError('Bps must be an integer', { bps });
    return new Money(roundHalfUp(this.amountMinor * BigInt(bps), BPS_DENOMINATOR), this.currency);
  }

  min(other: Money): Money {
    this.assertSameCurrency(other);
    // Stryker disable next-line EqualityOperator: on equal amounts `<` returns an equal Money
    return this.amountMinor <= other.amountMinor ? this : other;
  }

  isNegative(): boolean {
    return this.amountMinor < 0n;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency)
      throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
