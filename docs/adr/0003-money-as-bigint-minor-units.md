# 0003 — Money as BigInt minor units

Date: 2026-09-25 Status: accepted

## Context

Order totals involve multiplication, percentage discounts and tax. Floating point loses
cents; `INT` overflows at ~21 million units; `DECIMAL` in JavaScript needs a library and
still invites accidental `Number` arithmetic.

## Decision

- Database: `BIGINT` minor units + `CHAR(3)` currency (`price_minor`, `total_minor`, …).
- Code: `bigint` inside the `Money` value object (`shared/domain/money.ts`), which owns all
  arithmetic, currency checks and `roundHalfUp` for basis-point percentages.
- JSON edge: `{ amountMinor: number, currency: "EUR" }`; `bigint → number` only in
  `toMoneyDto`, which refuses values beyond `Number.MAX_SAFE_INTEGER`. Inputs arrive as
  integers and become `BigInt` in the DTO → command mapping.
- Rates are integers in basis points (`taxRateBps`, `valueBps`, 10000 = 100 %).

## Consequences

- Calculations are exact and deterministic; property tests in Step 1 can assert equalities.
- The largest possible order (50 × 1000 × 100 000 000) is 5 × 10^12, far below 2^53.
- Every money field in the API is an object, never a bare number.
