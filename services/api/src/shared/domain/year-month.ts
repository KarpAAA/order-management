/** A calendar month in UTC; `month` is 1–12. */
export interface YearMonth {
  readonly year: number;
  readonly month: number;
}

/** Months since year 0: one number to compare and to step by. */
export const monthIndex = (value: YearMonth): number => value.year * 12 + (value.month - 1);

export const yearMonthOf = (date: Date): YearMonth => ({
  year: date.getUTCFullYear(),
  month: date.getUTCMonth() + 1,
});

export function addMonths(value: YearMonth, count: number): YearMonth {
  const index = monthIndex(value) + count;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}
