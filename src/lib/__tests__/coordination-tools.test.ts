import { describe, expect, it } from 'vitest';
import { fakeSupabase } from './fake-supabase';
import { ANA, BEN, HOUSE, ME, baseTables, call, enabled, notifySpy } from './mcp-helpers';

const TURN = '44444444-4444-4444-8444-444444444444';
const SWAP = '55555555-5555-4555-8555-555555555555';

type Filter = { method: string; args: unknown[] };
const inserts = (calls: ReturnType<typeof fakeSupabase>['calls'], table: string) =>
  calls.filters.filter((f) => f.table === table && f.method === 'insert').map((f) => f.args[0]);
const rpcCalls = (calls: ReturnType<typeof fakeSupabase>['calls'], name: string) =>
  calls.rpc.filter(([n]) => n === name);

const myTurn = {
  id: TURN, assignee_id: ME, status: 'pending', chore_id: 'c1', chore: { name: 'Dishes', emoji: '🍽️' },
};

describe('list_swaps', () => {
  const rows = [
    { id: 's1', requested_by: ANA, requested_to: ME, status: 'pending', message: 'Can you?',
      created_at: '2026-10-28T03:00:00Z', turn: { id: TURN, due_at: null, chore: { name: 'Trash', emoji: '🗑️' } } },
    { id: 's2', requested_by: ME, requested_to: BEN, status: 'pending', message: null,
      created_at: '2026-10-20T15:00:00Z', turn: { id: 't2', due_at: null, chore: { name: 'Dishes', emoji: '🍽️' } } },
  ];

  it('shows which swaps were asked of you and which you asked', async () => {
    const { client, calls } = fakeSupabase({ tables: { ...baseTables, chore_swaps: rows }, rpc: enabled });
    const { data } = await call(client, 'list_swaps');

    expect(data.swaps.map((s: { direction: string }) => s.direction)).toEqual(['asked_of_you', 'asked_by_you']);
    expect(data.swaps[0]).toMatchObject({ swap_id: 's1', chore: 'Trash', from: 'Aiden Brooks', message: 'Can you?' });
    // 3am UTC on the 28th is still the 27th in Detroit.
    expect(data.swaps[0].asked_on).toBe('2026-10-27');
    // Only your own swaps, and pending ones by default.
    expect(calls.filters).toContainEqual({
      table: 'chore_swaps', method: 'or', args: [`requested_by.eq.${ME},requested_to.eq.${ME}`],
    });
    expect(calls.filters).toContainEqual({ table: 'chore_swaps', method: 'eq', args: ['status', 'pending'] });
  });

  it('includes finished swaps on request', async () => {
    const { client, calls } = fakeSupabase({ tables: { ...baseTables, chore_swaps: rows }, rpc: enabled });
    await call(client, 'list_swaps', { include_resolved: true });
    expect(calls.filters.some((f) => f.method === 'eq' && f.args[0] === 'status')).toBe(false);
  });
});

describe('request_swap', () => {
  const swapHouse = (turn: unknown = myTurn, open = false) =>
    fakeSupabase({
      tables: {
        ...baseTables,
        chore_turns: turn ? [turn] : [],
        chore_swaps: (f: Filter[]) => (f.some((x) => x.method === 'insert') ? [{ id: 'swap-1' }] : open ? [{ id: 'old' }] : []),
      } as never,
      rpc: enabled,
    });

  it('asks the housemate and tells them', async () => {
    const { client, calls } = swapHouse();
    const notify = notifySpy();
    const { data } = await call(client, 'request_swap', { turn_id: TURN, with: 'Aiden', message: 'Out Thursday' }, notify);

    expect(data).toMatchObject({ ok: true, swap_id: 'swap-1', asked: 'Aiden Brooks', chore: 'Dishes' });
    expect(inserts(calls, 'chore_swaps')).toEqual([
      { turn_id: TURN, requested_by: ME, requested_to: ANA, message: 'Out Thursday' },
    ]);
    expect(notify).toHaveBeenCalledWith([ANA], expect.objectContaining({ title: 'Chore swap request' }));
  });

  it('only lets you offer your own pending turn', async () => {
    const theirs = await call(swapHouse({ ...myTurn, assignee_id: ANA }).client, 'request_swap', { turn_id: TURN, with: 'Brandon' });
    expect(theirs.text).toMatch(/not yours/);

    const done = await call(swapHouse({ ...myTurn, status: 'done' }).client, 'request_swap', { turn_id: TURN, with: 'Brandon' });
    expect(done.text).toMatch(/already finished/);

    const missing = await call(swapHouse(null).client, 'request_swap', { turn_id: TURN, with: 'Brandon' });
    expect(missing.text).toMatch(/No such turn/);
  });

  it('will not swap with yourself, an unknown person, or when one is already open', async () => {
    expect((await call(swapHouse().client, 'request_swap', { turn_id: TURN, with: 'me' })).text).toMatch(/yourself/);
    expect((await call(swapHouse().client, 'request_swap', { turn_id: TURN, with: 'Zed' })).isError).toBe(true);

    const { client, calls } = swapHouse(myTurn, true);
    const dupe = await call(client, 'request_swap', { turn_id: TURN, with: 'Aiden' });
    expect(dupe.text).toMatch(/already an open swap/);
    expect(inserts(calls, 'chore_swaps')).toHaveLength(0);
  });

  it('rejects a malformed turn id before touching the database', async () => {
    const { client, calls } = swapHouse();
    expect((await call(client, 'request_swap', { turn_id: 'nope', with: 'Aiden' })).isError).toBe(true);
    expect(calls.filters.some((f) => f.table === 'chore_turns')).toBe(false);
  });
});

describe('respond_to_swap', () => {
  const swapFor = (over: Record<string, unknown> = {}) =>
    fakeSupabase({
      tables: { ...baseTables, chore_swaps: [{ id: SWAP, requested_to: ME, status: 'pending', ...over }] },
      rpc: enabled,
    });

  it('accepts through the same RPC the app uses', async () => {
    const { client, calls } = swapFor();
    const { data } = await call(client, 'respond_to_swap', { swap_id: SWAP, accept: true });
    expect(data).toMatchObject({ ok: true, result: 'accepted' });
    expect(rpcCalls(calls, 'accept_swap')).toEqual([['accept_swap', { p_swap: SWAP }]]);
  });

  it('declines by marking the swap declined, without swapping anything', async () => {
    const { client, calls } = swapFor();
    const { data } = await call(client, 'respond_to_swap', { swap_id: SWAP, accept: false });
    expect(data.result).toBe('declined');
    expect(rpcCalls(calls, 'accept_swap')).toHaveLength(0);
    expect(calls.filters).toContainEqual({
      table: 'chore_swaps', method: 'update',
      args: [expect.objectContaining({ status: 'declined', resolved_at: expect.any(String) })],
    });
  });

  it('only lets the person it was offered to answer, and only while pending', async () => {
    const notMine = await call(swapFor({ requested_to: ANA }).client, 'respond_to_swap', { swap_id: SWAP, accept: true });
    expect(notMine.text).toMatch(/Only the person/);

    const { client, calls } = swapFor({ status: 'accepted' });
    const done = await call(client, 'respond_to_swap', { swap_id: SWAP, accept: true });
    expect(done.text).toMatch(/already accepted/);
    expect(rpcCalls(calls, 'accept_swap')).toHaveLength(0);
  });

  it('passes the database’s refusal back', async () => {
    const { client } = fakeSupabase({
      tables: { ...baseTables, chore_swaps: [{ id: SWAP, requested_to: ME, status: 'pending' }] },
      rpc: { ...enabled, accept_swap: new Error('that turn is no longer pending') },
    });
    const out = await call(client, 'respond_to_swap', { swap_id: SWAP, accept: true });
    expect(out.text).toBe('that turn is no longer pending');
  });
});

describe('set_away / clear_away', () => {
  const awayHouse = () => fakeSupabase({ tables: baseTables, rpc: { ...enabled, set_away: {}, clear_away: null } });

  it('marks you away until the start of the return day, in the house’s timezone', async () => {
    const { client, calls } = awayHouse();
    const { data } = await call(client, 'set_away', { until: '2099-01-01' });
    expect(data).toMatchObject({ ok: true, away: true, until: '2099-01-01' });
    // Midnight on Jan 1 in Detroit (UTC-5 in winter).
    expect(rpcCalls(calls, 'set_away')).toEqual([['set_away', { p_until: '2099-01-01T05:00:00.000Z' }]]);
  });

  it('follows daylight saving: the same midnight in July is UTC-4', async () => {
    const { client, calls } = awayHouse();
    await call(client, 'set_away', { until: '2099-07-01' });
    expect(rpcCalls(calls, 'set_away')).toEqual([['set_away', { p_until: '2099-07-01T04:00:00.000Z' }]]);
  });

  it('stays away indefinitely with no date', async () => {
    const { client, calls } = awayHouse();
    await call(client, 'set_away');
    expect(rpcCalls(calls, 'set_away')).toEqual([['set_away', { p_until: null }]]);
  });

  it('refuses a return date that is not in the future, or not a real date', async () => {
    const { client, calls } = awayHouse();
    expect((await call(client, 'set_away', { until: '2000-01-01' })).text).toMatch(/after today/);
    expect((await call(client, 'set_away', { until: '2099-02-30' })).isError).toBe(true);
    expect(rpcCalls(calls, 'set_away')).toHaveLength(0);
  });

  it('brings you back', async () => {
    const { client, calls } = awayHouse();
    const { data } = await call(client, 'clear_away');
    expect(data).toMatchObject({ ok: true, away: false });
    expect(rpcCalls(calls, 'clear_away')).toHaveLength(1);
  });

  it('needs the chores module', async () => {
    const { client } = fakeSupabase({ tables: baseTables, rpc: { ...enabled, enabled_modules: ['mcp', 'expenses'] } });
    expect((await call(client, 'set_away', {})).text).toMatch(/chores/);
  });
});

describe('post_kiosk_message', () => {
  const kioskHouse = (modules = ['mcp', 'kiosk']) =>
    fakeSupabase({ tables: { ...baseTables, kiosk_messages: [] }, rpc: { enabled_modules: modules } });

  it('posts a trimmed note under your name', async () => {
    const { client, calls } = kioskHouse();
    const { data } = await call(client, 'post_kiosk_message', { body: '  Plumber Thursday 2pm  ' });
    expect(data).toMatchObject({ ok: true, posted: 'Plumber Thursday 2pm' });
    expect(inserts(calls, 'kiosk_messages')).toEqual([
      { household_id: HOUSE, author_id: ME, body: 'Plumber Thursday 2pm' },
    ]);
  });

  it('refuses blank, over-long, and when the house has no wall display', async () => {
    const { client, calls } = kioskHouse();
    expect((await call(client, 'post_kiosk_message', { body: '   ' })).text).toMatch(/Say something/);
    expect((await call(client, 'post_kiosk_message', { body: 'x'.repeat(281) })).isError).toBe(true);
    expect(inserts(calls, 'kiosk_messages')).toHaveLength(0);

    const off = await call(kioskHouse(['mcp', 'chores']).client, 'post_kiosk_message', { body: 'hi' });
    expect(off.text).toMatch(/kiosk/);
  });
});
