import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  bearerToken, protectedResourceMetadata, resourceMetadataUrl, type McpPrincipal,
} from '../mcp/auth';
import { handleMcp } from '../mcp/handler';
import { WRITE_TOOLS } from '../mcp/common';
import { matchChore } from '../mcp/tools';
import { fakeSupabase } from './fake-supabase';

const ME = '11111111-1111-4111-8111-111111111111';
const HOUSE = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';

function principal(supabase: SupabaseClient): McpPrincipal {
  return { userId: ME, clientId: 'claude', supabase: supabase as McpPrincipal['supabase'] };
}

const baseTables = {
  profiles: [{ id: ME, household_id: HOUSE, full_name: 'Tejas', initials: 'TT', is_admin: true }],
  households: [{ id: HOUSE, name: '526 Detroit St.', timezone: 'America/Detroit' }],
};

function rpcRequest(method: string, params: unknown = {}, id = 1) {
  return new Request('https://app.example/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

async function call(
  supabase: SupabaseClient,
  name: string,
  args: Record<string, unknown> = {},
  notify = vi.fn(async () => undefined),
) {
  const res = await handleMcp(rpcRequest('tools/call', { name, arguments: args }), {
    authenticate: async () => principal(supabase),
    notify,
  });
  const body = await res.json();
  return { res, body, notify };
}

const text = (body: { result: { content: { text: string }[] } }) => body.result.content[0].text;

describe('bearerToken', () => {
  it('reads a bearer header, case-insensitively', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer abc')).toBe('abc');
  });

  it('rejects anything else', () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
  });
});

describe('discovery metadata', () => {
  it('points clients at Supabase as the authorization server', () => {
    const meta = protectedResourceMetadata('https://app.example', 'https://abc.supabase.co/');
    expect(meta.resource).toBe('https://app.example/api/mcp');
    expect(meta.authorization_servers).toEqual(['https://abc.supabase.co/auth/v1']);
  });

  it('puts the metadata URL in the 401 challenge', async () => {
    const res = await handleMcp(
      new Request('https://app.example/api/mcp', { method: 'POST', body: '{}' }),
      { authenticate: async () => null, notify: vi.fn() },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${resourceMetadataUrl('https://app.example')}"`,
    );
  });
});

describe('transport', () => {
  it('refuses GET and DELETE rather than holding a stream open', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await handleMcp(new Request('https://app.example/api/mcp', { method }), {
        authenticate: async () => {
          throw new Error('must not authenticate a 405');
        },
        notify: vi.fn(),
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('answers initialize and lists the tools over plain JSON', async () => {
    const { client } = fakeSupabase({});
    const deps = { authenticate: async () => principal(client), notify: vi.fn() };

    const init = await handleMcp(
      rpcRequest('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      }),
      deps,
    );
    expect(init.headers.get('content-type')).toContain('application/json');
    expect((await init.json()).result.serverInfo.name).toBe('domestic');

    const list = await handleMcp(rpcRequest('tools/list', {}, 2), deps);
    const tools = (await list.json()).result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_expense', 'add_itemized_expense', 'chore_history', 'chore_stats', 'clear_away', 'complete_chore',
      'flag_chore', 'get_balances', 'get_expense', 'get_household', 'list_chores', 'list_expenses',
      'list_recurring_expenses', 'list_settlements', 'list_swaps', 'post_kiosk_message', 'recent_activity',
      'record_payment', 'request_settle_up', 'request_swap', 'respond_to_swap', 'set_away',
    ]);

    // Every tool that can change something is metered as a write, and nothing else is, so a
    // new write tool cannot slip past the tighter budget.
    const declaredWrites = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name).sort();
    expect(declaredWrites).toEqual([...WRITE_TOOLS].sort());
  });

  it('offers prompts and a house resource, which need no database', async () => {
    const { client, calls } = fakeSupabase({});
    const deps = { authenticate: async () => principal(client), notify: vi.fn() };

    const prompts = await (await handleMcp(rpcRequest('prompts/list', {}, 3), deps)).json();
    expect(prompts.result.prompts.map((p: { name: string }) => p.name).sort()).toEqual([
      'add_receipt', 'chore_fairness', 'settle_up', 'weekly_digest',
    ]);

    const digest = await (await handleMcp(rpcRequest('prompts/get', { name: 'weekly_digest' }, 4), deps)).json();
    expect(digest.result.messages[0].content.text).toMatch(/get_balances/);

    const fairness = await (
      await handleMcp(rpcRequest('prompts/get', { name: 'chore_fairness', arguments: { days: '14' } }, 5), deps)
    ).json();
    expect(fairness.result.messages[0].content.text).toMatch(/last 14 days/);

    const resources = await (await handleMcp(rpcRequest('resources/list', {}, 6), deps)).json();
    expect(resources.result.resources[0].uri).toBe('domestic://house');
    // Listing prompts and resources never touches the database.
    expect(calls.filters).toEqual([]);
  });
});

describe('household gate', () => {
  it('refuses every tool while the house has not enabled the module', async () => {
    const { client } = fakeSupabase({
      tables: baseTables,
      rpc: { enabled_modules: ['chores', 'expenses', 'kiosk'] },
    });
    const { body } = await call(client, 'get_household');
    expect(body.result.isError).toBe(true);
    expect(text(body)).toMatch(/switched off/);
  });

  it('fails closed when the module lookup returns nothing', async () => {
    const { client } = fakeSupabase({ tables: baseTables, rpc: {} });
    const { body } = await call(client, 'list_chores');
    expect(body.result.isError).toBe(true);
  });

  it('refuses a tool whose own module is off', async () => {
    const { client } = fakeSupabase({ tables: baseTables, rpc: { enabled_modules: ['mcp', 'chores'] } });
    const { body } = await call(client, 'get_balances');
    expect(body.result.isError).toBe(true);
    expect(text(body)).toMatch(/expenses/);
  });
});

describe('tools', () => {
  const enabled = { enabled_modules: ['mcp', 'chores', 'expenses'] };

  it('reports balances as integer cents with a remainder-safe settle-up', async () => {
    const { client } = fakeSupabase({
      tables: {
        ...baseTables,
        // A $40.03 grocery run split four ways leaves 1-cent differences.
        profiles: [
          ...baseTables.profiles,
          { id: 'a', household_id: HOUSE, full_name: 'Aiden', initials: 'AB' },
          { id: 'b', household_id: HOUSE, full_name: 'Brandon', initials: 'BK' },
        ],
        v_balances: [
          { profile_id: 'a', net_cents: 3002 },
          { profile_id: 'b', net_cents: -3002 },
        ],
      },
      rpc: enabled,
    });
    const { body } = await call(client, 'get_balances');
    const out = JSON.parse(text(body));
    // The caller has no ledger row, which reads as zero rather than a gap.
    expect(out.balances.map((b: { net_cents: number }) => b.net_cents)).toEqual([0, 3002, -3002]);
    expect(out.settle_up).toEqual([
      { from: 'Brandon', to: 'Aiden', cents: 3002, amount: '$30.02' },
    ]);
  });

  it('completes a chore through the same RPC as the app, as the caller', async () => {
    const { client, calls } = fakeSupabase({
      tables: {
        ...baseTables,
        chore_turns: [{
          id: TURN, chore_id: 'c1', assignee_id: ME, chore: { name: 'Dishes', emoji: '🍽️' },
        }],
      },
      rpc: { ...enabled, complete_turn: {} },
    });
    const { body } = await call(client, 'complete_chore', { turn_id: TURN, note: 'done' });
    expect(JSON.parse(text(body))).toEqual({ ok: true, completed: 'Dishes' });
    expect(calls.rpc).toContainEqual([
      'complete_turn', { p_turn: TURN, p_note: 'done', p_lat: null, p_lon: null },
    ]);
  });

  it('passes Postgres refusals through, such as a location rule', async () => {
    const { client } = fakeSupabase({
      tables: {
        ...baseTables,
        chore_turns: [{ id: TURN, chore_id: 'c1', assignee_id: ME, chore: { name: 'Dishes', emoji: '🍽️' } }],
      },
      rpc: { ...enabled, complete_turn: new Error('turn on location to complete chores for this house') },
    });
    const { body } = await call(client, 'complete_chore', { turn_id: TURN });
    expect(body.result.isError).toBe(true);
    expect(text(body)).toMatch(/turn on location/);
  });

  it('rejects a malformed turn id before touching the database', async () => {
    const { client, calls } = fakeSupabase({ tables: baseTables, rpc: enabled });
    const { body } = await call(client, 'complete_chore', { turn_id: 'not-a-uuid' });
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(calls.rpc.find(([n]) => n === 'complete_turn')).toBeUndefined();
  });

  it('flags a chore by name and notifies whoever is up', async () => {
    const { client, calls } = fakeSupabase({
      tables: { ...baseTables, chores: [{ id: 'c1', name: 'Dishes', emoji: '🍽️' }] },
      rpc: { ...enabled, flag_on_demand: { id: TURN, assignee_id: 'b' } },
    });
    const notify = vi.fn(async () => undefined);
    const { body } = await call(client, 'flag_chore', { chore: 'dishes' }, notify);
    expect(JSON.parse(text(body))).toMatchObject({ ok: true, flagged: 'Dishes' });
    expect(calls.rpc).toContainEqual(['flag_on_demand', { p_chore: 'c1' }]);
    expect(notify).toHaveBeenCalledWith(['b'], expect.objectContaining({ tag: 'chore-c1' }));
  });
});

describe('matchChore', () => {
  const chores = [
    { id: 'c1', name: 'Dishes' },
    { id: 'c2', name: 'Take out trash' },
  ];

  it('matches by id, name, or slug', () => {
    expect(matchChore(chores, 'c1')?.name).toBe('Dishes');
    expect(matchChore(chores, 'DISHES')?.name).toBe('Dishes');
    expect(matchChore(chores, 'take_out_trash')?.name).toBe('Take out trash');
    expect(matchChore(chores, 'laundry')).toBeUndefined();
  });
});
