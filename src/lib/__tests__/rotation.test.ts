import { describe, expect, it } from 'vitest';
import { assigneeForTurn, bucketFor, describeCadence, upcomingRotation } from '../rotation';

// The order printed on the fridge chart.
const ORDER = ['AB', 'BK', 'TT', 'NA'];

describe('assigneeForTurn', () => {
  it('reproduces the printed sequence', () => {
    const first8 = Array.from({ length: 8 }, (_, i) => assigneeForTurn(ORDER, i));
    expect(first8).toEqual(['AB', 'BK', 'TT', 'NA', 'AB', 'BK', 'TT', 'NA']);
  });

  it('never drifts, however far out you go', () => {
    expect(assigneeForTurn(ORDER, 4000)).toBe('AB');
    expect(assigneeForTurn(ORDER, 4001)).toBe('BK');
  });

  it('handles an empty rotation', () => {
    expect(assigneeForTurn([], 3)).toBeNull();
  });
});

describe('upcomingRotation', () => {
  it('lists who is up and who follows', () => {
    expect(upcomingRotation(ORDER, 2, 4)).toEqual(['TT', 'NA', 'AB', 'BK']);
  });
});

describe('describeCadence', () => {
  it('describes Floors the way the chart does', () => {
    expect(
      describeCadence({
        cadence: 'scheduled',
        days_of_week: [0, 5],
        interval_weeks: 1,
        description: null,
      }),
    ).toBe('Sun & Fri, every week');
  });

  it('describes the biweekly microwave', () => {
    expect(
      describeCadence({
        cadence: 'scheduled',
        days_of_week: [6],
        interval_weeks: 2,
        description: null,
      }),
    ).toBe('Sat, every other week');
  });

  it('uses the description for on-demand chores', () => {
    expect(
      describeCadence({
        cadence: 'on_demand',
        days_of_week: [],
        interval_weeks: 1,
        description: 'Run and unload a load',
      }),
    ).toBe('Run and unload a load');
  });
});

describe('bucketFor', () => {
  const now = new Date('2026-08-30T15:00:00');

  it('treats a null due date as anytime', () => {
    expect(bucketFor(null, now)).toBe('anytime');
  });

  it('flags yesterday as overdue', () => {
    expect(bucketFor(new Date('2026-08-29T20:00:00').toISOString(), now)).toBe('overdue');
  });

  it('buckets later today, tomorrow, and beyond', () => {
    expect(bucketFor(new Date('2026-08-30T20:00:00').toISOString(), now)).toBe('today');
    expect(bucketFor(new Date('2026-08-31T20:00:00').toISOString(), now)).toBe('tomorrow');
    expect(bucketFor(new Date('2026-09-04T20:00:00').toISOString(), now)).toBe('upcoming');
  });

  it('counts earlier today as today, not overdue', () => {
    // 8am today with a 3pm "now" — late, but it is still your day to do it.
    expect(bucketFor(new Date('2026-08-30T08:00:00').toISOString(), now)).toBe('today');
  });
});
