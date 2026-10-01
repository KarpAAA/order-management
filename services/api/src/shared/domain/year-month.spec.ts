import { describe, expect, it } from 'vitest';

import { addMonths, monthIndex, yearMonthOf } from './year-month';

describe('YearMonth', () => {
  it('reads the month of a date in UTC, whatever the local time zone', () => {
    // 23:30 on 30 September in UTC is already October east of Greenwich
    expect(yearMonthOf(new Date('2026-09-30T23:30:00.000Z'))).toEqual({ year: 2026, month: 9 });
    expect(yearMonthOf(new Date('2026-10-01T00:00:00.000Z'))).toEqual({ year: 2026, month: 10 });
  });

  it('steps over the year boundary in both directions', () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 11 }, 3)).toEqual({ year: 2027, month: 2 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 5 }, 0)).toEqual({ year: 2026, month: 5 });
  });

  it('orders months by one index', () => {
    expect(monthIndex({ year: 2026, month: 12 })).toBeLessThan(
      monthIndex({ year: 2027, month: 1 }),
    );
    expect(monthIndex({ year: 2027, month: 1 }) - monthIndex({ year: 2026, month: 12 })).toBe(1);
  });
});
