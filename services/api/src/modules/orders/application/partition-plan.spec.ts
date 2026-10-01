import { describe, expect, it } from 'vitest';

import type { YearMonth } from '@shared/domain/year-month';

import { planPartitions } from './partition-plan';

const ym = (year: number, month: number): YearMonth => ({ year, month });
const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('planPartitions', () => {
  it('asks for the current month and every month ahead when nothing exists', () => {
    const plan = planPartitions({ now: NOW, existing: [], monthsAhead: 3, retentionMonths: 0 });

    expect(plan.create).toEqual([ym(2026, 10), ym(2026, 11), ym(2026, 12), ym(2027, 1)]);
    expect(plan.drop).toEqual([]);
  });

  it('creates only the missing months', () => {
    const plan = planPartitions({
      now: NOW,
      existing: [ym(2026, 10), ym(2026, 12)],
      monthsAhead: 3,
      retentionMonths: 0,
    });

    expect(plan.create).toEqual([ym(2026, 11), ym(2027, 1)]);
  });

  it('creates nothing when the window is already covered', () => {
    const plan = planPartitions({
      now: NOW,
      existing: [ym(2026, 9), ym(2026, 10), ym(2026, 11)],
      monthsAhead: 1,
      retentionMonths: 0,
    });

    expect(plan).toEqual({ create: [], drop: [] });
  });

  it('takes the current month in UTC on the last second of a month', () => {
    const plan = planPartitions({
      now: new Date('2026-12-31T23:59:59.999Z'),
      existing: [],
      monthsAhead: 1,
      retentionMonths: 0,
    });

    expect(plan.create).toEqual([ym(2026, 12), ym(2027, 1)]);
  });

  it('keeps every old month when retention is off (0)', () => {
    const plan = planPartitions({
      now: NOW,
      existing: [ym(2020, 1), ym(2026, 10)],
      monthsAhead: 0,
      retentionMonths: 0,
    });

    expect(plan.drop).toEqual([]);
  });

  it('drops the months older than the retention, oldest first', () => {
    const plan = planPartitions({
      now: NOW,
      existing: [ym(2026, 8), ym(2026, 7), ym(2026, 5), ym(2026, 6), ym(2026, 9), ym(2026, 10)],
      monthsAhead: 0,
      retentionMonths: 2,
    });

    // October is current; September and August are the two kept months
    expect(plan.drop).toEqual([ym(2026, 5), ym(2026, 6), ym(2026, 7)]);
  });

  it('never drops the current month or a future one, even with the shortest retention', () => {
    const plan = planPartitions({
      now: NOW,
      existing: [ym(2026, 9), ym(2026, 10), ym(2026, 11)],
      monthsAhead: 1,
      retentionMonths: 1,
    });

    expect(plan.drop).toEqual([]);
  });

  it('counts the retention across the year boundary', () => {
    const plan = planPartitions({
      now: new Date('2027-01-10T00:00:00.000Z'),
      existing: [ym(2026, 10), ym(2026, 11), ym(2026, 12), ym(2027, 1)],
      monthsAhead: 0,
      retentionMonths: 2,
    });

    expect(plan.drop).toEqual([ym(2026, 10)]);
  });
});
