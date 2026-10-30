import { describe, expect, it } from 'vitest';
import { fakeSupabase } from './fake-supabase';
import { ANA, BEN, HOUSE, ME, baseTables, call, enabled, notifySpy } from './mcp-helpers';

type Filter = { method: string; args: unknown[] };
const isDupeQuery = (f: Filter[]) => f.some((x) => x.method === 'gte' && x.args[0] === 'created_at');
const wrote = (calls: ReturnType<typeof fakeSupabase>['calls'], name: string) =>
  calls.rpc.filter(([n]) => n === name);

/** An expenses table that reports a recent identical expense only when asked about duplicates. */
const expenses = (dupe: boolean) => (f: Filter[]) => (dupe && isDupeQuery(f) ? [{ id: 'old' }] : []);

const house = (extra: Record<string, unknown> = {}, rpc: Record<string, unknown> = {}) =>
  fakeSupabase({
    tables: { ...baseTables, expenses: expenses(false), ...extra } as never,
    rpc: { ...enabled, create_expense: { id: 'exp-1' }, create_itemized_expense: { id: 'exp-2' }, ...rpc },
  });

describe('add_expense', () => {
  const groceries = { description: 'Groceries', amount_cents: 4730, category: 'groceries' };

  it('previews by default and records nothing', async () => {
    const { client, calls } = house();
    const { data } = await call(client, 'add_expense', groceries);

    expect(data.confirmed).toBe(false);
    expect(data.nothing_recorded_yet).toBe(true);
    expect(data.preview.amount).toBe('$47.30');
    expect(data.preview.paid_by).toBe('Tejas Thiyagarajan');
    expect(data.preview.shares.map((s: { cents: number }) => s.cents)).toEqual([1577, 1577, 1576]);
    expect(data.next).toMatch(/confirm: true/);
    expect(wrote(calls, 'create_expense')).toHaveLength(0);
  });

  it('records it, atomically through one RPC, once confirmed', async () => {
    const { client, calls } = house();
    const notify = notifySpy();
    const { data } = await call(client, 'add_expense', { ...groceries, confirm: true }, notify);

    expect(data).toMatchObject({ confirmed: true, recorded: true, expense_id: 'exp-1' });
    const [[, args]] = wrote(calls, 'create_expense') as [[string, Record<string, unknown>]];
    expect(args).toMatchObject({
      p_description: 'Groceries', p_amount_cents: 4730, p_paid_by: ME, p_split_kind: 'equal',
      p_category: 'groceries', p_note: null,
    });
    const shares = args.p_shares as { owed_cents: number }[];
    expect(shares.reduce((sum, s) => sum + s.owed_cents, 0)).toBe(4730);
  });

  it('tells each housemate their own share, but not the person who paid', async () => {
    const { client } = house();
    const notify = notifySpy();
    await call(client, 'add_expense', { ...groceries, confirm: true }, notify);

    const notified = notify.mock.calls.map(([ids]) => ids[0]).sort();
    expect(notified).toEqual([ANA, BEN].sort());
    expect(notify).toHaveBeenCalledWith(
      [ANA],
      expect.objectContaining({ title: 'Groceries — $47.30', body: expect.stringContaining('Your share is $15.77') }),
    );
  });

  it('splits only among the people named, with exact amounts by name', async () => {
    const { client } = house();
    const { data } = await call(client, 'add_expense', {
      description: 'Gift', amount_cents: 5000, split_between: ['me', 'Aiden'],
      split_kind: 'exact', values: { me: 3000, Aiden: 2000 },
    });
    expect(data.preview.shares).toEqual([
      { person: 'Tejas Thiyagarajan', cents: 3000, amount: '$30.00' },
      { person: 'Aiden Brooks', cents: 2000, amount: '$20.00' },
    ]);
  });

  it('refuses amounts that do not add up, and amounts for people outside the split', async () => {
    const { client, calls } = house();
    const short = await call(client, 'add_expense', {
      description: 'Gift', amount_cents: 5000, split_between: ['me', 'Aiden'],
      split_kind: 'exact', values: { me: 3000, Aiden: 1000 },
    });
    expect(short.isError).toBe(true);
    expect(short.text).toMatch(/1000 cents short/);

    const stray = await call(client, 'add_expense', {
      description: 'Gift', amount_cents: 5000, split_between: ['me'],
      split_kind: 'exact', values: { me: 4000, Brandon: 1000 },
    });
    expect(stray.text).toMatch(/Brandon Kauten has an amount but is not in split_between/);
    expect(wrote(calls, 'create_expense')).toHaveLength(0);
  });

  it('only takes whole cents', async () => {
    const { client, calls } = house();
    for (const amount_cents of [47.3, 0, -100, 100_000_001]) {
      const out = await call(client, 'add_expense', { ...groceries, amount_cents, confirm: true });
      expect(out.isError).toBe(true);
    }
    expect(wrote(calls, 'create_expense')).toHaveLength(0);
  });

  it('names the housemates when someone does not match', async () => {
    const { client } = house();
    const out = await call(client, 'add_expense', { ...groceries, paid_by: 'Zed' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/Aiden Brooks/);
  });

  it('lets someone else be the payer', async () => {
    const { client } = house();
    const { data } = await call(client, 'add_expense', { ...groceries, paid_by: 'Brandon' });
    expect(data.preview.paid_by).toBe('Brandon Kauten');
  });

  it('warns on a repeat at preview, refuses it on confirm, and allows it when told it is real', async () => {
    const { client, calls } = house({ expenses: expenses(true) });

    const preview = await call(client, 'add_expense', groceries);
    expect(preview.data.warning).toMatch(/identical expense/);

    const refused = await call(client, 'add_expense', { ...groceries, confirm: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/allow_duplicate/);
    expect(wrote(calls, 'create_expense')).toHaveLength(0);

    const allowed = await call(client, 'add_expense', { ...groceries, confirm: true, allow_duplicate: true });
    expect(allowed.data.recorded).toBe(true);
  });

  it('passes the database’s own refusal back to the assistant', async () => {
    const { client } = house({}, { create_expense: new Error('the payer must be in your household') });
    const out = await call(client, 'add_expense', { ...groceries, confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toBe('the payer must be in your household');
  });

  it('is refused when the house does not use expenses', async () => {
    const { client } = house({}, { enabled_modules: ['mcp', 'chores'] });
    const out = await call(client, 'add_expense', groceries);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/expenses/);
  });
});

describe('add_itemized_expense', () => {
  const receipt = {
    description: 'Costco',
    receipt_total_cents: 5400,
    lines: [
      { name: 'Paper towels', amount_cents: 2000, assigned_to: ['me'] },
      { name: 'Snacks', amount_cents: 2800 },
      { name: 'Tax', amount_cents: 600, kind: 'tax' },
    ],
  };

  it('refuses when the lines do not add up to the printed total, and says by how much', async () => {
    const { client, calls } = house();
    const out = await call(client, 'add_itemized_expense', { ...receipt, receipt_total_cents: 5500, confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/add up to \$54\.00 but the receipt total is \$55\.00 — \$1\.00 short/);
    expect(wrote(calls, 'create_itemized_expense')).toHaveLength(0);

    const over = await call(client, 'add_itemized_expense', { ...receipt, receipt_total_cents: 5300 });
    expect(over.text).toMatch(/\$1\.00 over/);
  });

  it('previews each line and what each person owes, writing nothing', async () => {
    const { client, calls } = house();
    const { data } = await call(client, 'add_itemized_expense', receipt);

    expect(data.confirmed).toBe(false);
    expect(data.preview.amount).toBe('$54.00');
    expect(data.preview.lines.map((l: { name: string }) => l.name)).toEqual(['Paper towels', 'Snacks', 'Tax']);
    expect(data.preview.lines[0].shared_by).toEqual(['Tejas Thiyagarajan']);
    expect(data.preview.lines[1].shared_by).toHaveLength(3);
    const owes = Object.fromEntries(
      data.preview.each_person_owes.map((p: { person: string; cents: number }) => [p.person, p.cents]),
    );
    expect(Object.values(owes).reduce((a: number, b) => a + (b as number), 0)).toBe(5400);
    expect(wrote(calls, 'create_itemized_expense')).toHaveLength(0);
  });

  it('records the receipt through the atomic RPC with every line in order, once confirmed', async () => {
    const { client, calls } = house();
    const notify = notifySpy();
    const { data } = await call(client, 'add_itemized_expense', { ...receipt, confirm: true }, notify);

    expect(data).toMatchObject({ recorded: true, expense_id: 'exp-2' });
    const [[, args]] = wrote(calls, 'create_itemized_expense') as [[string, Record<string, unknown>]];
    expect(args).toMatchObject({ p_description: 'Costco', p_paid_by: ME, p_receipt_url: null });

    const items = args.p_items as { name: string; kind: string; position: number; amount_cents: number; splits: { owed_cents: number }[] }[];
    expect(items.map((i) => [i.name, i.kind, i.position])).toEqual([
      ['Paper towels', 'item', 0], ['Snacks', 'item', 1], ['Tax', 'tax', 2],
    ]);
    // Each line's shares are exactly its amount, which is what the database enforces.
    for (const item of items) {
      expect(item.splits.reduce((sum, s) => sum + s.owed_cents, 0)).toBe(item.amount_cents);
    }
    expect(notify).toHaveBeenCalled();
  });

  it('catches the sign mistake an assistant makes on a discount', async () => {
    const { client } = house();
    const out = await call(client, 'add_itemized_expense', {
      description: 'Target', receipt_total_cents: 1500,
      lines: [{ name: 'Shirt', amount_cents: 2000 }, { name: 'Coupon', amount_cents: -500 }],
    });
    // A negative amount on a plain item is the usual slip; it must say so.
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/only a discount/);
  });

  it('names the line when someone on it is not in the house', async () => {
    const { client } = house();
    const out = await call(client, 'add_itemized_expense', {
      ...receipt, lines: [{ name: 'Wine', amount_cents: 5400, assigned_to: ['Zed'] }],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/On "Wine"/);
  });

  it('refuses a repeat of a receipt that was just recorded', async () => {
    const { client, calls } = house({ expenses: expenses(true) });
    const out = await call(client, 'add_itemized_expense', { ...receipt, confirm: true });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/allow_duplicate/);
    expect(wrote(calls, 'create_itemized_expense')).toHaveLength(0);
  });
});

describe('record_payment', () => {
  const payment = { to: 'Aiden', amount_cents: 5000, method: 'cash' };
  const settlements = (dupe: boolean) => (f: Filter[]) =>
    f.some((x) => x.method === 'insert') ? [{ id: 'pay-1' }] : dupe && isDupeQuery(f) ? [{ id: 'old' }] : [];

  const payHouse = (dupe = false) =>
    fakeSupabase({
      tables: { ...baseTables, settlements: settlements(dupe), settle_nudges: [] } as never,
      rpc: enabled,
    });
  const inserted = (calls: ReturnType<typeof fakeSupabase>['calls'], table: string) =>
    calls.filters.filter((f) => f.table === table && f.method === 'insert').map((f) => f.args[0]);

  it('previews first and writes nothing', async () => {
    const { client, calls } = payHouse();
    const { data } = await call(client, 'record_payment', payment);
    expect(data.confirmed).toBe(false);
    expect(data.preview).toMatchObject({ from: 'Tejas Thiyagarajan', to: 'Aiden Brooks', amount: '$50.00', method: 'cash' });
    expect(data.note).toMatch(/does not move any money/);
    expect(inserted(calls, 'settlements')).toHaveLength(0);
  });

  it('logs it, tells the other person, and clears the nudges it answers, once confirmed', async () => {
    const { client, calls } = payHouse();
    const notify = notifySpy();
    const { data } = await call(client, 'record_payment', { ...payment, confirm: true }, notify);

    expect(data).toMatchObject({ recorded: true, settlement_id: 'pay-1' });
    expect(inserted(calls, 'settlements')).toEqual([
      expect.objectContaining({
        household_id: HOUSE, from_profile: ME, to_profile: ANA, amount_cents: 5000,
        method: 'cash', created_by: ME,
      }),
    ]);
    expect(notify).toHaveBeenCalledWith([ANA], expect.objectContaining({ title: 'You got paid' }));
    // The signed-in person paid, so nobody else is told on their behalf.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(calls.filters).toContainEqual({
      table: 'settle_nudges', method: 'update', args: [expect.objectContaining({ dismissed_at: expect.any(String) })],
    });
  });

  it('can log a payment between two other people, telling both', async () => {
    const { client } = payHouse();
    const notify = notifySpy();
    await call(client, 'record_payment', { from: 'Brandon', to: 'Aiden', amount_cents: 1200, confirm: true }, notify);
    expect(notify.mock.calls.map(([ids]) => ids[0]).sort()).toEqual([ANA, BEN].sort());
  });

  it('needs two different people and a whole, positive amount', async () => {
    const { client } = payHouse();
    expect((await call(client, 'record_payment', { to: 'me', amount_cents: 100 })).text).toMatch(/two different people/);
    expect((await call(client, 'record_payment', { to: 'Aiden', amount_cents: 12.5 })).isError).toBe(true);
    expect((await call(client, 'record_payment', { to: 'Aiden', amount_cents: 0 })).isError).toBe(true);
  });

  it('refuses a repeat unless told it is real', async () => {
    const { client, calls } = payHouse(true);
    const refused = await call(client, 'record_payment', { ...payment, confirm: true });
    expect(refused.isError).toBe(true);
    expect(inserted(calls, 'settlements')).toHaveLength(0);

    const allowed = await call(client, 'record_payment', { ...payment, confirm: true, allow_duplicate: true });
    expect(allowed.data.recorded).toBe(true);
  });
});

describe('request_settle_up', () => {
  const nudges = (open: boolean) => (f: Filter[]) =>
    f.some((x) => x.method === 'insert') ? [] : open ? [{ id: 'n1' }] : [];
  const nudgeHouse = (open = false) =>
    fakeSupabase({
      tables: { ...baseTables, settle_nudges: nudges(open), activity_log: [] } as never,
      rpc: enabled,
    });

  it('sends a nudge, notifies the debtor, and logs it', async () => {
    const { client, calls } = nudgeHouse();
    const notify = notifySpy();
    const { data } = await call(client, 'request_settle_up', { from: 'Aiden', amount_cents: 2513 }, notify);

    expect(data).toMatchObject({ ok: true, nudged: 'Aiden Brooks', amount: '$25.13' });
    expect(calls.filters).toContainEqual({
      table: 'settle_nudges', method: 'insert',
      args: [{ household_id: HOUSE, from_profile: ANA, to_profile: ME, amount_cents: 2513 }],
    });
    expect(notify).toHaveBeenCalledWith([ANA], expect.objectContaining({ body: expect.stringContaining('$25.13') }));
    expect(calls.filters.some((f) => f.table === 'activity_log' && f.method === 'insert')).toBe(true);
  });

  it('will not nudge yourself, or someone you already have an open nudge with', async () => {
    expect((await call(nudgeHouse().client, 'request_settle_up', { from: 'me', amount_cents: 100 })).text)
      .toMatch(/nudge yourself/);

    const { client, calls } = nudgeHouse(true);
    const out = await call(client, 'request_settle_up', { from: 'Aiden', amount_cents: 100 });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/already has an open nudge/);
    expect(calls.filters.some((f) => f.table === 'settle_nudges' && f.method === 'insert')).toBe(false);
  });
});
