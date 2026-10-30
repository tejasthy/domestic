import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dayBoundsUtc, describeRecurrence, escapeLike, isCalendarDay, localDay, resolvePerson,
  summarizeExpenses, tallyTurns,
} from '../mcp/ledger';
import { handleMcp } from '../mcp/handler';
import { fakeSupabase } from './fake-supabase';

const ME = '11111111-1111-4111-8111-111111111111';
const HOUSE = '22222222-2222-4222-8222-222222222222';
const EXPENSE = '44444444-4444-4444-8444-444444444444';

const PEOPLE = [
  { id: ME, household_id: HOUSE, full_name: 'Tejas Thiyagarajan', initials: 'TT', is_admin: true },
  { id: 'a', household_id: HOUSE, full_name: 'Aiden Brooks', initials: 'AB', is_admin: false },
  { id: 'b', household_id: HOUSE, full_name: 'Brandon Kauten', initials: 'BK', is_admin: false },
  { id: 'n', household_id: HOUSE, full_name: 'Nolen Armstrong', initials: 'NA', is_admin: false },
];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('summarizeExpenses', () => {
  // A $146.59 keg split four ways leaves remainder cents: 3665 x3 and 3664.
  const keg = {
    amount_cents: 14659,
    category: 'drinks',
    paid_by: ME,
    splits: [
      { profile_id: ME, owed_cents: 3665 },
      { profile_id: 'a', owed_cents: 3665 },
      { profile_id: 'b', owed_cents: 3665 },
      { profile_id: 'n', owed_cents: 3664 },
    ],
  };
  const internet = {
    amount_cents: 10050,
    category: 'utilities',
    paid_by: 'a',
    splits: [
      { profile_id: ME, owed_cents: 2513 },
      { profile_id: 'a', owed_cents: 2513 },
      { profile_id: 'b', owed_cents: 2512 },
      { profile_id: 'n', owed_cents: 2512 },
    ],
  };

  it('answers "how much did I cover for everyone else"', () => {
    const { by_person } = summarizeExpenses([keg, internet]);
    const me = by_person.find((p) => p.id === ME)!;
    // The three others' shares of the keg, not the whole keg.
    expect(me.paid_for_others_cents).toBe(3665 + 3665 + 3664);
    // And what others covered for me: my share of the internet bill.
    expect(me.others_paid_for_me_cents).toBe(2513);
    expect(me.paid_cents).toBe(14659);
    expect(me.share_cents).toBe(3665 + 2513);
  });

  it('adds up exactly, in integer cents', () => {
    const out = summarizeExpenses([keg, internet]);
    expect(out.total_cents).toBe(14659 + 10050);
    expect(sum(out.by_person.map((p) => p.paid_cents))).toBe(out.total_cents);
    expect(sum(out.by_category.map((c) => c.cents))).toBe(out.total_cents);
    for (const p of out.by_person) {
      for (const v of [p.paid_cents, p.share_cents, p.paid_for_others_cents, p.others_paid_for_me_cents]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it('conserves money: what some covered is exactly what others were covered', () => {
    const { by_person } = summarizeExpenses([keg, internet]);
    expect(sum(by_person.map((p) => p.paid_for_others_cents))).toBe(
      sum(by_person.map((p) => p.others_paid_for_me_cents)),
    );
  });

  it('does not count a payer’s own share as paid for others', () => {
    const solo = { amount_cents: 500, category: 'x', paid_by: ME, splits: [{ profile_id: ME, owed_cents: 500 }] };
    expect(summarizeExpenses([solo]).by_person[0].paid_for_others_cents).toBe(0);
  });

  it('orders categories largest first', () => {
    expect(summarizeExpenses([keg, internet]).by_category.map((c) => c.category)).toEqual([
      'drinks', 'utilities',
    ]);
  });

  it('is empty for no expenses', () => {
    expect(summarizeExpenses([])).toEqual({ total_cents: 0, by_person: [], by_category: [] });
  });
});

describe('tallyTurns', () => {
  it('credits the person the turn belonged to, per chore', () => {
    const out = tallyTurns(
      [
        { chore_id: 'c1', assignee_id: 'a' }, { chore_id: 'c1', assignee_id: 'a' },
        { chore_id: 'c2', assignee_id: 'a' }, { chore_id: 'c1', assignee_id: 'b' },
      ],
      [{ chore_id: 'c2', assignee_id: 'b' }],
    );
    const a = out.find((t) => t.id === 'a')!;
    const b = out.find((t) => t.id === 'b')!;
    expect([a.done, a.missed]).toEqual([3, 0]);
    expect([b.done, b.missed]).toEqual([1, 1]);
    expect(a.by_chore).toContainEqual({ chore_id: 'c1', done: 2, missed: 0 });
    expect(b.by_chore).toContainEqual({ chore_id: 'c2', done: 0, missed: 1 });
  });

  it('is empty when nothing happened', () => {
    expect(tallyTurns([], [])).toEqual([]);
  });
});

describe('resolvePerson', () => {
  it('accepts me, a first name, a full name, initials, or an id', () => {
    expect(resolvePerson(PEOPLE, 'me', ME)).toEqual({ id: ME });
    expect(resolvePerson(PEOPLE, 'Aiden', ME)).toEqual({ id: 'a' });
    expect(resolvePerson(PEOPLE, 'brandon kauten', ME)).toEqual({ id: 'b' });
    expect(resolvePerson(PEOPLE, 'NA', ME)).toEqual({ id: 'n' });
    expect(resolvePerson(PEOPLE, ME, 'a')).toEqual({ id: ME });
  });

  it('refuses an ambiguous name rather than guessing', () => {
    const twins = [...PEOPLE, { ...PEOPLE[1], id: 'a2', full_name: 'Aiden Cole', initials: 'AC' }];
    const out = resolvePerson(twins, 'aiden', ME);
    expect(out).toHaveProperty('error');
    expect((out as { error: string }).error).toMatch(/Aiden Brooks, Aiden Cole/);
  });

  it('lists the housemates when nobody matches', () => {
    const out = resolvePerson(PEOPLE, 'Zed', ME) as { error: string };
    expect(out.error).toMatch(/Tejas Thiyagarajan/);
  });
});

describe('dates', () => {
  it('accepts only real calendar days', () => {
    expect(isCalendarDay('2026-10-29')).toBe(true);
    expect(isCalendarDay('2026-02-30')).toBe(false);
    expect(isCalendarDay('2026-13-01')).toBe(false);
    expect(isCalendarDay('10/29/2026')).toBe(false);
    expect(isCalendarDay("2026-10-29'; drop")).toBe(false);
  });

  it('reads the day as the house wall clock does', () => {
    // 11:30pm on the 29th in Detroit is already the 30th in UTC.
    expect(localDay('2026-10-30T03:30:00Z', 'America/Detroit')).toBe('2026-10-29');
    expect(localDay('2026-10-30T03:30:00Z', 'UTC')).toBe('2026-10-30');
  });

  it('bounds a day range in the house timezone, across the fall DST change', () => {
    // October: EDT (UTC-4). The range runs to the start of the day after `until`.
    expect(dayBoundsUtc('2026-10-01', '2026-10-31', 'America/Detroit')).toEqual({
      from: '2026-10-01T04:00:00.000Z',
      before: '2026-11-01T04:00:00.000Z',
    });
    // Nov 1 is when clocks fall back, so the next midnight is EST (UTC-5).
    expect(dayBoundsUtc(undefined, '2026-11-01', 'America/Detroit')).toEqual({
      before: '2026-11-02T05:00:00.000Z',
    });
    expect(dayBoundsUtc(undefined, undefined, 'America/Detroit')).toEqual({});
  });
});

describe('describeRecurrence', () => {
  it('reads naturally', () => {
    const base = { interval_weeks: 1, interval_months: 1, day_of_month: null };
    expect(describeRecurrence({ ...base, cadence: 'weekly' })).toBe('every week');
    expect(describeRecurrence({ ...base, cadence: 'weekly', interval_weeks: 2 })).toBe('every 2 weeks');
    expect(describeRecurrence({ ...base, cadence: 'monthly', day_of_month: 1 })).toBe('every month on the 1st');
    expect(describeRecurrence({ ...base, cadence: 'monthly', day_of_month: 22 })).toBe('every month on the 22nd');
    expect(describeRecurrence({ ...base, cadence: 'monthly', day_of_month: 11 })).toBe('every month on the 11th');
    expect(describeRecurrence({ ...base, cadence: 'monthly', interval_months: 3 })).toBe('every 3 months');
  });
});

describe('escapeLike', () => {
  it('makes wildcards literal', () => {
    expect(escapeLike('100%_off\\')).toBe('100\\%\\_off\\\\');
  });
});

/* ---------------------------------------------------------------- the tools */

const baseTables = {
  profiles: PEOPLE,
  households: [{ id: HOUSE, name: '526 Detroit St.', timezone: 'America/Detroit' }],
};
const enabled = { enabled_modules: ['mcp', 'chores', 'expenses'] };

async function call(supabase: SupabaseClient, name: string, args: Record<string, unknown> = {}) {
  const res = await handleMcp(
    new Request('https://app.example/api/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    {
      authenticate: async () => ({ userId: ME, clientId: 'test', supabase: supabase as never }),
      notify: vi.fn(),
    },
  );
  const body = await res.json();
  const text: string | undefined = body.result?.content?.[0]?.text;
  return { body, isError: !!body.result?.isError || !!body.error, text, data: text && !body.result?.isError ? safeJson(text) : null };
}

const safeJson = (t: string) => {
  try { return JSON.parse(t); } catch { return null; }
};

const keg = {
  id: EXPENSE, description: 'Keg', amount_cents: 14659, category: 'drinks', paid_by: ME,
  spent_on: '2026-10-19', split_kind: 'equal', note: null,
  splits: [
    { profile_id: ME, owed_cents: 3665 }, { profile_id: 'a', owed_cents: 3665 },
    { profile_id: 'b', owed_cents: 3665 }, { profile_id: 'n', owed_cents: 3664 },
  ],
  items: [],
};
const internet = {
  id: '55555555-5555-4555-8555-555555555555', description: 'Xfinity', amount_cents: 10050,
  category: 'utilities', paid_by: 'a', spent_on: '2026-10-19', split_kind: 'itemized',
  note: null,
  splits: [
    { profile_id: ME, owed_cents: 2513 }, { profile_id: 'a', owed_cents: 2513 },
    { profile_id: 'b', owed_cents: 2512 }, { profile_id: 'n', owed_cents: 2512 },
  ],
  items: [{ id: 'i1' }],
};

describe('list_expenses', () => {
  it('totals over every match and reports what I covered for others', async () => {
    const { client } = fakeSupabase({ tables: { ...baseTables, expenses: [keg, internet] }, rpc: enabled });
    const { data } = await call(client, 'list_expenses', { since: '2026-10-01', until: '2026-10-31' });

    expect(data.total.cents).toBe(24709);
    expect(data.complete).toBe(true);
    const me = data.by_person.find((p: { id: string }) => p.id === ME);
    expect(me.name).toBe('Tejas Thiyagarajan');
    expect(me.paid_for_others.cents).toBe(10994);
    expect(me.others_paid_for_me.cents).toBe(2513);
    expect(me.paid_for_others.amount).toBe('$109.94');
  });

  it('marks itemized expenses and counts their lines, without ever reading a receipt path', async () => {
    const { client, calls } = fakeSupabase({ tables: { ...baseTables, expenses: [keg, internet] }, rpc: enabled });
    const { data } = await call(client, 'list_expenses');
    expect(data.expenses.map((e: { itemized: boolean }) => e.itemized)).toEqual([false, true]);
    expect(data.expenses[1].item_count).toBe(1);
    expect(data.expenses[0]).not.toHaveProperty('has_receipt');
    const selects = calls.filters.filter((f) => f.method === 'select').map((f) => String(f.args[0]));
    expect(selects.some((s) => s.includes('receipt_url'))).toBe(false);
  });

  it('builds the date, payer and search filters, with wildcards escaped', async () => {
    const { client, calls } = fakeSupabase({ tables: { ...baseTables, expenses: [keg] }, rpc: enabled });
    await call(client, 'list_expenses', {
      since: '2026-10-01', until: '2026-10-31', paid_by: 'me', search: '100%_deal',
    });
    const f = calls.filters.filter((x) => x.table === 'expenses');
    expect(f).toContainEqual({ table: 'expenses', method: 'gte', args: ['spent_on', '2026-10-01'] });
    expect(f).toContainEqual({ table: 'expenses', method: 'lte', args: ['spent_on', '2026-10-31'] });
    expect(f).toContainEqual({ table: 'expenses', method: 'eq', args: ['paid_by', ME] });
    expect(f).toContainEqual({ table: 'expenses', method: 'ilike', args: ['description', '%100\\%\\_deal%'] });
    expect(f).toContainEqual({ table: 'expenses', method: 'is', args: ['deleted_at', null] });
  });

  it('keeps only expenses the named person paid or owes a share of', async () => {
    const outsider = { ...keg, id: 'x', paid_by: 'a', splits: [{ profile_id: 'a', owed_cents: 500 }], amount_cents: 500 };
    const { client } = fakeSupabase({ tables: { ...baseTables, expenses: [keg, outsider] }, rpc: enabled });
    const { data } = await call(client, 'list_expenses', { involving: 'Tejas' });
    expect(data.matched).toBe(1);
    expect(data.total.cents).toBe(14659);
  });

  it('says so when the scan limit was hit, instead of undercounting silently', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ ...keg, id: `e${i}` }));
    const { client } = fakeSupabase({ tables: { ...baseTables, expenses: many }, rpc: enabled });
    const { data } = await call(client, 'list_expenses', { limit: 10 });
    expect(data.complete).toBe(false);
    expect(data.showing).toBe(10);
    expect(data.matched).toBe(300);
  });

  it('shows who owes what only when asked', async () => {
    const { client } = fakeSupabase({ tables: { ...baseTables, expenses: [keg] }, rpc: enabled });
    expect((await call(client, 'list_expenses')).data.expenses[0].shares).toBeUndefined();
    const withShares = (await call(client, 'list_expenses', { include_shares: true })).data;
    expect(withShares.expenses[0].shares).toHaveLength(4);
  });

  it('rejects an impossible date before querying', async () => {
    const { client, calls } = fakeSupabase({ tables: { ...baseTables, expenses: [keg] }, rpc: enabled });
    const out = await call(client, 'list_expenses', { since: '2026-02-30' });
    expect(out.isError).toBe(true);
    expect(calls.filters.some((x) => x.table === 'expenses')).toBe(false);
  });

  it('names the housemates when the person is not one of them', async () => {
    const { client } = fakeSupabase({ tables: { ...baseTables, expenses: [keg] }, rpc: enabled });
    const out = await call(client, 'list_expenses', { paid_by: 'Zed' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Aiden Brooks/);
  });

  it('is refused when the house does not use expenses', async () => {
    const { client } = fakeSupabase({ tables: baseTables, rpc: { enabled_modules: ['mcp', 'chores'] } });
    const out = await call(client, 'list_expenses');
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/expenses/);
  });
});

describe('get_expense', () => {
  const receipt = {
    ...keg, id: EXPENSE, description: 'Costco', amount_cents: 1000, split_kind: 'itemized',
    splits: [{ profile_id: ME, owed_cents: 600, weight: null }, { profile_id: 'a', owed_cents: 400, weight: null }],
    items: [
      { id: 'i2', name: 'Tip', amount_cents: 100, kind: 'tip', split_kind: 'equal', position: 2,
        item_splits: [{ profile_id: ME, owed_cents: 50 }, { profile_id: 'a', owed_cents: 50 }] },
      { id: 'i1', name: 'Paper towels', amount_cents: 900, kind: 'item', split_kind: 'exact', position: 1,
        item_splits: [{ profile_id: ME, owed_cents: 550 }, { profile_id: 'a', owed_cents: 350 }] },
    ],
  };

  it('returns line items in receipt order with who owes each', async () => {
    const { client } = fakeSupabase({ tables: { ...baseTables, expenses: [receipt] }, rpc: enabled });
    const { data } = await call(client, 'get_expense', { expense_id: EXPENSE });
    expect(data.split_kind).toBe('itemized');
    expect(data.itemized).toBe(true);
    expect(data.items.map((i: { name: string }) => i.name)).toEqual(['Paper towels', 'Tip']);
    expect(data.items[1].kind).toBe('tip');
    expect(data.items[0].shares).toEqual([
      { person: 'Tejas Thiyagarajan', cents: 550, amount: '$5.50' },
      { person: 'Aiden Brooks', cents: 350, amount: '$3.50' },
    ]);
    expect(data.shares_add_up).toBe(true);
  });

  it('flags shares that do not add up to the total', async () => {
    const broken = { ...receipt, splits: [{ profile_id: ME, owed_cents: 600, weight: null }] };
    const { client } = fakeSupabase({ tables: { ...baseTables, expenses: [broken] }, rpc: enabled });
    expect((await call(client, 'get_expense', { expense_id: EXPENSE })).data.shares_add_up).toBe(false);
  });

  it('refuses a malformed id and an unknown one', async () => {
    const { client } = fakeSupabase({ tables: { ...baseTables, expenses: [] }, rpc: enabled });
    expect((await call(client, 'get_expense', { expense_id: 'nope' })).isError).toBe(true);
    const missing = await call(client, 'get_expense', { expense_id: EXPENSE });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No such expense/);
  });
});

describe('list_settlements', () => {
  const payment = {
    id: 's1', from_profile: 'a', to_profile: ME, amount_cents: 5000, settled_on: '2026-10-25',
    method: 'venmo', note: null,
  };

  it('names both sides and filters by a resolved person id only', async () => {
    const { client, calls } = fakeSupabase({ tables: { ...baseTables, settlements: [payment] }, rpc: enabled });
    const { data } = await call(client, 'list_settlements', { person: 'Aiden' });
    expect(data.settlements[0]).toMatchObject({ from: 'Aiden Brooks', to: 'Tejas Thiyagarajan', cents: 5000 });
    expect(calls.filters).toContainEqual({
      table: 'settlements', method: 'or', args: ['from_profile.eq.a,to_profile.eq.a'],
    });
  });
});

describe('list_recurring_expenses', () => {
  it('describes the schedule and the split', async () => {
    const { client } = fakeSupabase({
      tables: {
        ...baseTables,
        recurring_expenses: [{
          id: 'r1', description: 'Rent', amount_cents: 240000, category: 'rent', paid_by: ME,
          split_kind: 'equal', cadence: 'monthly', interval_weeks: 1, interval_months: 1,
          day_of_month: 1, next_run_on: '2026-11-01', is_active: true,
          participants: [{ profile_id: ME, owed_cents: 60000 }, { profile_id: 'a', owed_cents: 60000 }],
        }],
      },
      rpc: enabled,
    });
    const { data } = await call(client, 'list_recurring_expenses');
    expect(data.recurring[0]).toMatchObject({
      description: 'Rent', repeats: 'every month on the 1st', next_run_on: '2026-11-01', paid_by: 'Tejas Thiyagarajan',
    });
    expect(data.recurring[0].shares[0].amount).toBe('$600.00');
  });
});

describe('chore_history', () => {
  const turns = [
    { id: 't1', chore_id: 'c1', assignee_id: 'a', completed_by: ME, completed_at: '2026-10-28T03:15:00Z',
      note: null, chore: { name: 'Dishes', emoji: '🍽️' } },
    { id: 't2', chore_id: 'c1', assignee_id: ME, completed_by: ME, completed_at: '2026-10-19T20:00:00Z',
      note: 'big load', chore: { name: 'Dishes', emoji: '🍽️' } },
  ];

  it('dates completions on the house’s calendar and shows who covered for whom', async () => {
    const { client } = fakeSupabase({
      tables: { ...baseTables, chores: [{ id: 'c1', name: 'Dishes' }], chore_turns: turns },
      rpc: enabled,
    });
    const { data } = await call(client, 'chore_history');
    // 3:15am UTC on the 28th is still the 27th in Detroit.
    expect(data.completed[0]).toMatchObject({ chore: 'Dishes', done_by: 'Tejas Thiyagarajan', covered_for: 'Aiden Brooks', date: '2026-10-27' });
    expect(data.completed[1].covered_for).toBeUndefined();
    expect(data.completed[1].note).toBe('big load');
  });

  it('turns a day range into house-timezone UTC bounds, person and chore into ids', async () => {
    const { client, calls } = fakeSupabase({
      tables: { ...baseTables, chores: [{ id: 'c1', name: 'Dishes' }], chore_turns: turns },
      rpc: enabled,
    });
    await call(client, 'chore_history', { since: '2026-10-01', until: '2026-10-31', person: 'me', chore: 'dishes' });
    const f = calls.filters.filter((x) => x.table === 'chore_turns');
    expect(f).toContainEqual({ table: 'chore_turns', method: 'gte', args: ['completed_at', '2026-10-01T04:00:00.000Z'] });
    expect(f).toContainEqual({ table: 'chore_turns', method: 'lt', args: ['completed_at', '2026-11-01T04:00:00.000Z'] });
    expect(f).toContainEqual({ table: 'chore_turns', method: 'eq', args: ['completed_by', ME] });
    expect(f).toContainEqual({ table: 'chore_turns', method: 'eq', args: ['chore_id', 'c1'] });
  });

  it('lists the known chores when the name does not match', async () => {
    const { client } = fakeSupabase({
      tables: { ...baseTables, chores: [{ id: 'c1', name: 'Dishes' }] },
      rpc: enabled,
    });
    const out = await call(client, 'chore_history', { chore: 'laundry' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Dishes/);
  });
});

describe('chore_stats', () => {
  it('tallies done and missed per person and per chore', async () => {
    const { client } = fakeSupabase({
      tables: {
        ...baseTables,
        chores: [{ id: 'c1', name: 'Dishes' }, { id: 'c2', name: 'Trash' }],
        v_chore_stats: [
          { chore_id: 'c1', profile_id: ME, done_count: 7, missed_count: 1, last_done_at: '2026-10-27T00:00:00Z' },
          { chore_id: 'c2', profile_id: ME, done_count: 9, missed_count: 0, last_done_at: null },
          { chore_id: 'c1', profile_id: 'a', done_count: 5, missed_count: 2, last_done_at: null },
        ],
      },
      rpc: enabled,
    });
    const { data } = await call(client, 'chore_stats');
    const me = data.people.find((p: { name: string }) => p.name === 'Tejas Thiyagarajan');
    expect(me.done).toBe(16);
    expect(me.missed).toBe(1);
    expect(me.by_chore[0]).toMatchObject({ chore: 'Trash', done: 9 });
    expect(data.people.find((p: { name: string }) => p.name === 'Nolen Armstrong').done).toBe(0);
  });
});

describe('chore_stats in a window', () => {
  const byStatus = (done: unknown[], missed: unknown[]) => (filters: { method: string; args: unknown[] }[]) => {
    const status = filters.find((f) => f.method === 'eq' && f.args[0] === 'status')?.args[1];
    return status === 'done' ? done : missed;
  };
  const turn = (assignee_id: string, chore_id = 'c1') => ({ chore_id, assignee_id });

  it('counts who did the least, with zeros for people who did none', async () => {
    const { client, calls } = fakeSupabase({
      tables: {
        ...baseTables,
        chores: [{ id: 'c1', name: 'Dishes' }, { id: 'c2', name: 'Trash' }],
        chore_turns: byStatus(
          [turn('b'), turn('b'), turn('b', 'c2'), turn('a'), turn('a'), turn(ME), turn(ME), turn('n')],
          [turn('n', 'c2')],
        ),
      },
      rpc: enabled,
    });
    const { data } = await call(client, 'chore_stats', { since: '2026-10-19', until: '2026-10-29' });
    const done = Object.fromEntries(data.people.map((p: { name: string; done: number }) => [p.name, p.done]));
    expect(done).toEqual({
      'Tejas Thiyagarajan': 2, 'Aiden Brooks': 2, 'Brandon Kauten': 3, 'Nolen Armstrong': 1,
    });
    expect(data.people.find((p: { name: string }) => p.name === 'Nolen Armstrong').missed).toBe(1);
    expect(data.complete).toBe(true);

    // Done turns are dated by completion, missed ones by when they fell due; both in house time.
    const f = calls.filters.filter((x) => x.table === 'chore_turns');
    expect(f).toContainEqual({ table: 'chore_turns', method: 'gte', args: ['completed_at', '2026-10-19T04:00:00.000Z'] });
    expect(f).toContainEqual({ table: 'chore_turns', method: 'lt', args: ['completed_at', '2026-10-30T04:00:00.000Z'] });
    expect(f).toContainEqual({ table: 'chore_turns', method: 'gte', args: ['due_at', '2026-10-19T04:00:00.000Z'] });
  });

  it('shows people with no turns in the window as zero', async () => {
    const { client } = fakeSupabase({
      tables: { ...baseTables, chores: [], chore_turns: byStatus([turn('a')], []) },
      rpc: enabled,
    });
    const { data } = await call(client, 'chore_stats', { since: '2026-10-01' });
    expect(data.people.find((p: { name: string }) => p.name === 'Brandon Kauten')).toMatchObject({ done: 0, missed: 0 });
  });

  it('says so when the scan limit was hit rather than undercounting silently', async () => {
    const many = Array.from({ length: 1000 }, () => turn('a'));
    const { client } = fakeSupabase({
      tables: { ...baseTables, chores: [], chore_turns: byStatus(many, []) },
      rpc: enabled,
    });
    expect((await call(client, 'chore_stats', { since: '2026-01-01' })).data.complete).toBe(false);
  });

  it('stays all-time when no window is given', async () => {
    const { client, calls } = fakeSupabase({ tables: { ...baseTables, chores: [], v_chore_stats: [] }, rpc: enabled });
    await call(client, 'chore_stats');
    expect(calls.filters.some((x) => x.table === 'chore_turns')).toBe(false);
  });
});

describe('get_household', () => {
  it('gives the house’s own date so relative ranges resolve correctly', async () => {
    const { client } = fakeSupabase({ tables: { ...baseTables, member_away: [] }, rpc: enabled });
    const { data } = await call(client, 'get_household');
    expect(data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
