import { describe, expect, it } from 'vitest';
import { buildExpenseShares, buildReceiptItems, type ReceiptLine } from '../mcp/splits';

const A = 'a';
const B = 'b';
const C = 'c';
const D = 'd';
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('buildExpenseShares', () => {
  const ok = (r: ReturnType<typeof buildExpenseShares>) => {
    if (!r.ok) throw new Error(r.error);
    return r.shares;
  };

  it('splits equally, remainder-safe', () => {
    const shares = ok(buildExpenseShares('equal', 4730, [A, B, C]));
    expect(shares.map((s) => s.owed_cents)).toEqual([1577, 1577, 1576]);
    expect(sum(shares.map((s) => s.owed_cents))).toBe(4730);
  });

  it('always adds up to the total, whatever the amount and headcount', () => {
    const ids = [A, B, C, D];
    for (let total = 1; total <= 400; total++) {
      for (let n = 1; n <= 4; n++) {
        const shares = ok(buildExpenseShares('equal', total, ids.slice(0, n)));
        expect(sum(shares.map((s) => s.owed_cents))).toBe(total);
      }
    }
  });

  it('counts a person named twice once', () => {
    expect(ok(buildExpenseShares('equal', 1000, [A, A, B])).map((s) => s.profile_id)).toEqual([A, B]);
  });

  it('takes exact cents and insists they add up', () => {
    const shares = ok(buildExpenseShares('exact', 1000, [A, B], { [A]: 700, [B]: 300 }));
    expect(shares.map((s) => s.owed_cents)).toEqual([700, 300]);

    const short = buildExpenseShares('exact', 1000, [A, B], { [A]: 700, [B]: 200 });
    expect(short).toMatchObject({ ok: false });
    expect((short as { error: string }).error).toMatch(/100 cents short/);

    const over = buildExpenseShares('exact', 1000, [A, B], { [A]: 700, [B]: 400 });
    expect((over as { error: string }).error).toMatch(/100 cents over/);
  });

  it('refuses fractional or negative exact amounts', () => {
    expect(buildExpenseShares('exact', 1000, [A, B], { [A]: 700.5, [B]: 299.5 }).ok).toBe(false);
    expect(buildExpenseShares('exact', 1000, [A, B], { [A]: 1200, [B]: -200 }).ok).toBe(false);
  });

  it('needs an amount for everyone in a non-equal split', () => {
    const r = buildExpenseShares('exact', 1000, [A, B], { [A]: 1000 });
    expect(r.ok).toBe(false);
  });

  it('splits by shares in proportion, and leaves out anyone with zero', () => {
    const shares = ok(buildExpenseShares('shares', 1000, [A, B, C], { [A]: 2, [B]: 1, [C]: 0 }));
    expect(shares.map((s) => s.profile_id)).toEqual([A, B]);
    expect(shares.map((s) => s.owed_cents)).toEqual([667, 333]);
    expect(shares[0].weight).toBe(2);
  });

  it('requires percentages to add up to 100', () => {
    const shares = ok(buildExpenseShares('percent', 1001, [A, B], { [A]: 60, [B]: 40 }));
    expect(sum(shares.map((s) => s.owed_cents))).toBe(1001);
    const bad = buildExpenseShares('percent', 1000, [A, B], { [A]: 60, [B]: 30 });
    expect((bad as { error: string }).error).toMatch(/add up to 100/);
  });

  it('refuses a non-positive or fractional amount, and an empty split', () => {
    expect(buildExpenseShares('equal', 0, [A]).ok).toBe(false);
    expect(buildExpenseShares('equal', -5, [A]).ok).toBe(false);
    expect(buildExpenseShares('equal', 10.5, [A]).ok).toBe(false);
    expect(buildExpenseShares('equal', 1000, []).ok).toBe(false);
  });
});

describe('buildReceiptItems', () => {
  const house = [A, B, C];
  const build = (lines: ReceiptLine[], who = house) => {
    const r = buildReceiptItems(lines, who);
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  it('splits shared items among everyone and personal items among their owners', () => {
    const r = build([
      { name: 'Pizza', amount_cents: 3000, kind: 'item' },
      { name: "Ana's soda", amount_cents: 300, kind: 'item', assigned_to: [A] },
    ]);
    expect(r.per_person).toEqual({ [A]: 1300, [B]: 1000, [C]: 1000 });
    expect(r.total_cents).toBe(3300);
  });

  it('shares tax and tip in proportion to what each person bought', () => {
    const r = build([
      { name: 'Steak', amount_cents: 3000, kind: 'item', assigned_to: [A] },
      { name: 'Salad', amount_cents: 1000, kind: 'item', assigned_to: [B] },
      { name: 'Tax', amount_cents: 400, kind: 'tax' },
    ]);
    // Ana bought 75% of the food, Ben 25%, Cy nothing — so Cy pays no tax.
    const tax = r.items[2];
    expect(tax.split_kind).toBe('shares');
    expect(tax.splits.map((s) => [s.profile_id, s.owed_cents])).toEqual([[A, 300], [B, 100]]);
    expect(r.per_person).toEqual({ [A]: 3300, [B]: 1100 });
  });

  it('lets a person be named on tax or tip explicitly', () => {
    const r = build([
      { name: 'Meal', amount_cents: 2000, kind: 'item' },
      { name: 'Tip', amount_cents: 400, kind: 'tip', assigned_to: [A] },
    ]);
    expect(r.items[1].split_kind).toBe('equal');
    expect(r.per_person[A]).toBe(667 + 400);
  });

  it('applies a discount to those who bought the discounted item', () => {
    const r = build([
      { name: 'Shirt', amount_cents: 3000, kind: 'item', assigned_to: [A] },
      { name: 'Socks', amount_cents: 1000, kind: 'item', assigned_to: [B] },
      { name: 'Shirt coupon', amount_cents: -500, kind: 'discount', assigned_to: [A] },
    ]);
    expect(r.per_person).toEqual({ [A]: 2500, [B]: 1000 });
    expect(r.total_cents).toBe(3500);
  });

  it('spreads an unassigned discount in proportion to purchases', () => {
    const r = build([
      { name: 'Shirt', amount_cents: 3000, kind: 'item', assigned_to: [A] },
      { name: 'Socks', amount_cents: 1000, kind: 'item', assigned_to: [B] },
      { name: '10% off', amount_cents: -400, kind: 'discount' },
    ]);
    expect(r.per_person).toEqual({ [A]: 2700, [B]: 900 });
  });

  it('falls back to everyone when there is nothing to be proportional to', () => {
    const r = build([{ name: 'Service fee', amount_cents: 300, kind: 'fee' }]);
    expect(r.per_person).toEqual({ [A]: 100, [B]: 100, [C]: 100 });
  });

  it('catches the sign mistakes an assistant makes', () => {
    expect(buildReceiptItems([{ name: 'Coupon', amount_cents: 500, kind: 'discount' }], house)).toMatchObject({
      ok: false, error: expect.stringMatching(/discount.*negative/),
    });
    expect(buildReceiptItems([{ name: 'Milk', amount_cents: -300, kind: 'item' }], house)).toMatchObject({
      ok: false, error: expect.stringMatching(/only a discount/),
    });
    expect(buildReceiptItems([{ name: 'Free', amount_cents: 0, kind: 'item' }], house).ok).toBe(false);
    expect(buildReceiptItems([{ name: 'Milk', amount_cents: 3.5, kind: 'item' }], house).ok).toBe(false);
  });

  it('refuses a discount that would leave someone owing less than nothing', () => {
    const r = buildReceiptItems(
      [
        { name: 'Milk', amount_cents: 300, kind: 'item', assigned_to: [A] },
        { name: 'Big coupon', amount_cents: -500, kind: 'discount', assigned_to: [A] },
      ],
      house,
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/negative total/) });
  });

  it('refuses someone outside the house, and an empty receipt', () => {
    expect(
      buildReceiptItems([{ name: 'Milk', amount_cents: 300, kind: 'item', assigned_to: ['stranger'] }], house).ok,
    ).toBe(false);
    expect(buildReceiptItems([], house).ok).toBe(false);
  });

  it('keeps receipt order in each line’s position', () => {
    const r = build([
      { name: 'One', amount_cents: 100, kind: 'item' },
      { name: 'Two', amount_cents: 200, kind: 'item' },
      { name: 'Tax', amount_cents: 30, kind: 'tax' },
    ]);
    expect(r.items.map((i) => i.position)).toEqual([0, 1, 2]);
    expect(r.items.map((i) => i.name)).toEqual(['One', 'Two', 'Tax']);
  });

  it('adds up exactly on every receipt, however awkward the cents', () => {
    // A small deterministic generator, so a failure is reproducible.
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const everyone = [A, B, C, D];

    for (let trial = 0; trial < 300; trial++) {
      const lines: ReceiptLine[] = [];
      const itemCount = 1 + rand(6);
      for (let i = 0; i < itemCount; i++) {
        const owners = everyone.filter(() => rand(2) === 0);
        lines.push({
          name: `item ${i}`,
          amount_cents: 1 + rand(5000),
          kind: 'item',
          ...(owners.length > 0 && rand(2) === 0 ? { assigned_to: owners } : {}),
        });
      }
      lines.push({ name: 'Tax', amount_cents: 1 + rand(800), kind: 'tax' });
      if (rand(2) === 0) lines.push({ name: 'Tip', amount_cents: 1 + rand(1500), kind: 'tip' });

      const r = buildReceiptItems(lines, everyone);
      if (!r.ok) throw new Error(`trial ${trial}: ${r.error}`);

      const lineTotal = sum(lines.map((l) => l.amount_cents));
      expect(r.total_cents).toBe(lineTotal);
      expect(sum(Object.values(r.per_person))).toBe(lineTotal);
      for (const item of r.items) {
        // Each line's shares are exactly its own amount — what the database enforces.
        expect(sum(item.splits.map((s) => s.owed_cents))).toBe(item.amount_cents);
        for (const s of item.splits) expect(Number.isInteger(s.owed_cents)).toBe(true);
      }
    }
  });
});
