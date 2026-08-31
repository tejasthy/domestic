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
  // Fixed UTC instants + an explicit non-UTC zone, so the test doesn't depend
  // on the host machine's local timezone the way Date-local math would.
  const tz = 'America/Detroit';
  const now = new Date('2026-08-30T19:00:00Z'); // 3pm Eastern

  it('treats a null due date as anytime', () => {
    expect(bucketFor(null, tz, now)).toBe('anytime');
  });

  it('flags yesterday as overdue', () => {
    expect(bucketFor('2026-08-30T00:30:00Z', tz, now)).toBe('overdue'); // 8/29 8:30pm Eastern
  });

  it('buckets later today, tomorrow, and beyond', () => {
    expect(bucketFor('2026-08-31T00:00:00Z', tz, now)).toBe('today'); // 8/30 8pm Eastern
    expect(bucketFor('2026-09-01T00:00:00Z', tz, now)).toBe('tomorrow'); // 8/31 8pm Eastern
    expect(bucketFor('2026-09-05T00:00:00Z', tz, now)).toBe('upcoming'); // 9/4 8pm Eastern
  });

  it('counts earlier today as today, not overdue', () => {
    // 8am Eastern with a 3pm Eastern "now" — late, but it is still your day to do it.
    expect(bucketFor('2026-08-30T12:00:00Z', tz, now)).toBe('today');
  });

  it('respects the household timezone at the boundary', () => {
    // 11pm Eastern on 8/30 is already 8/31 in UTC — still "today" in Detroit.
    expect(bucketFor('2026-08-31T03:00:00Z', tz, now)).toBe('today');
  });
});
