import { describe, expect, it } from 'vitest';
import {
  formatCents, parseDollars, simplifyDebts, splitByAdjustment, splitByWeight, splitEqual,
} from '../money';

describe('splitEqual', () => {
  it('splits evenly when it divides cleanly', () => {
    expect(splitEqual(4000, ['a', 'b', 'c', 'd'])).toEqual({ a: 1000, b: 1000, c: 1000, d: 1000 });
  });

  it('always sums to the total, remainder or not', () => {
    // $40.03 across four people: 1000.75 each, which does not exist.
    const out = splitEqual(4003, ['a', 'b', 'c', 'd']);
    expect(Object.values(out).reduce((x, y) => x + y, 0)).toBe(4003);
    expect(out).toEqual({ a: 1001, b: 1001, c: 1001, d: 1000 });
  });

  it('handles one person and zero people', () => {
    expect(splitEqual(999, ['a'])).toEqual({ a: 999 });
    expect(splitEqual(999, [])).toEqual({});
  });

  it('never drifts across many odd splits', () => {
    // A year of $x.99 grocery runs is exactly how rounding bugs surface.
    for (let total = 1; total <= 500; total++) {
      const out = splitEqual(total, ['a', 'b', 'c']);
      expect(Object.values(out).reduce((x, y) => x + y, 0)).toBe(total);
    }
  });

  it('still sums exactly for a negative total (a discount item split across people)', () => {
    for (let total = -500; total <= -1; total++) {
      const out = splitEqual(total, ['a', 'b', 'c']);
      expect(Object.values(out).reduce((x, y) => x + y, 0)).toBe(total);
    }
  });
});

describe('splitByWeight', () => {
  it('splits proportionally and sums to the total', () => {
    const out = splitByWeight(10000, { a: 1, b: 1, c: 2 });
    expect(out).toEqual({ a: 2500, b: 2500, c: 5000 });
  });

  it('assigns leftover cents to the largest fractions', () => {
    const out = splitByWeight(1000, { a: 1, b: 1, c: 1 });
    expect(Object.values(out).reduce((x, y) => x + y, 0)).toBe(1000);
  });

  it('falls back to an equal split when all weights are zero', () => {
    expect(splitByWeight(300, { a: 0, b: 0 })).toEqual({ a: 150, b: 150 });
  });

  it('sums exactly for a negative total too', () => {
    const out = splitByWeight(-1000, { a: 1, b: 1, c: 2 });
    expect(Object.values(out).reduce((x, y) => x + y, 0)).toBe(-1000);
  });
});

describe('splitByAdjustment', () => {
  it('starts from equal, then applies each adjustment on top', () => {
    const out = splitByAdjustment(4000, ['a', 'b', 'c', 'd'], { a: 500, b: -500 });
    // Equal share of the remaining 4000 is 1000 each; a gets +500, b gets -500.
    expect(out).toEqual({ a: 1500, b: 500, c: 1000, d: 1000 });
    expect(Object.values(out).reduce((x, y) => x + y, 0)).toBe(4000);
  });

  it('sums to the total exactly with an odd remainder', () => {
    const out = splitByAdjustment(4003, ['a', 'b', 'c'], { a: 100 });
    expect(Object.values(out).reduce((x, y) => x + y, 0)).toBe(4003);
  });

  it('is a no-op equal split when there are no adjustments', () => {
    expect(splitByAdjustment(3000, ['a', 'b', 'c'], {})).toEqual({ a: 1000, b: 1000, c: 1000 });
  });

  it('handles adjustments for everyone summing to the whole total', () => {
    const out = splitByAdjustment(1000, ['a', 'b'], { a: 700, b: 300 });
    expect(out).toEqual({ a: 700, b: 300 });
  });
});

describe('simplifyDebts', () => {
  it('clears a simple two-person debt in one transfer', () => {
    expect(simplifyDebts({ a: -500, b: 500 })).toEqual([{ from: 'a', to: 'b', cents: 500 }]);
  });

  it('needs at most n-1 transfers and settles everyone', () => {
    const balances = { a: -3000, b: -1000, c: 1500, d: 2500 };
    const transfers = simplifyDebts(balances);

    expect(transfers.length).toBeLessThanOrEqual(3);

    const after = { ...balances };
    for (const t of transfers) {
      after[t.from as keyof typeof after] += t.cents;
      after[t.to as keyof typeof after] -= t.cents;
    }
    expect(after).toEqual({ a: 0, b: 0, c: 0, d: 0 });
  });

  it('returns nothing when everyone is square', () => {
    expect(simplifyDebts({ a: 0, b: 0 })).toEqual([]);
  });
});

describe('parseDollars', () => {
  it('reads the shapes people actually type', () => {
    expect(parseDollars('12.34')).toBe(1234);
    expect(parseDollars('$12.34')).toBe(1234);
    expect(parseDollars('12')).toBe(1200);
    expect(parseDollars('0.05')).toBe(5);
  });

  it('rounds rather than truncating', () => {
    expect(parseDollars('0.005')).toBe(1);
    expect(parseDollars('19.999')).toBe(2000);
  });

  it('rejects junk', () => {
    expect(parseDollars('')).toBeNull();
    expect(parseDollars('abc')).toBeNull();
    expect(parseDollars('.')).toBeNull();
  });
});

describe('formatCents', () => {
  it('renders whole dollars and cents', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(1234)).toBe('$12.34');
    expect(formatCents(100000)).toBe('$1,000.00');
  });
});
