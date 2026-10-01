import { addMonths, monthIndex, yearMonthOf } from '@shared/domain/year-month';
import type { YearMonth } from '@shared/domain/year-month';

export interface PartitionPlan {
  create: YearMonth[];
  drop: YearMonth[];
}

export interface PartitionPlanInput {
  now: Date;
  existing: readonly YearMonth[];
  /** Partitions kept ready after the current month. */
  monthsAhead: number;
  /** Full months of history kept besides the current one; 0 keeps everything. */
  retentionMonths: number;
}

/**
 * What the order history needs today: the current month and `monthsAhead` after it must exist;
 * months older than the retention go. The current month and later ones are never dropped.
 */
export function planPartitions(input: PartitionPlanInput): PartitionPlan {
  const current = yearMonthOf(input.now);
  const existing = new Set(input.existing.map(monthIndex));

  const create: YearMonth[] = [];
  for (let ahead = 0; ahead <= input.monthsAhead; ahead++) {
    const month = addMonths(current, ahead);
    if (!existing.has(monthIndex(month))) create.push(month);
  }

  if (input.retentionMonths === 0) return { create, drop: [] };
  const oldestKept = monthIndex(current) - input.retentionMonths;
  const drop = input.existing
    .filter((month) => monthIndex(month) < oldestKept)
    .sort((left, right) => monthIndex(left) - monthIndex(right));
  return { create, drop };
}
