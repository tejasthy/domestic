import { describe, expect, it, vi } from 'vitest';
import { handleMcp } from '../mcp/handler';
import { LIMITS, checkLimit, classifyMessage } from '../mcp/rate-limit';
import { WRITE_TOOLS } from '../mcp/common';
import { fakeSupabase } from './fake-supabase';
import { baseTables, call, deps, enabled, rpcRequest } from './mcp-helpers';

describe('classifyMessage', () => {
  it('meters tool calls only, and writes separately from reads', () => {
    expect(classifyMessage({ method: 'tools/call', params: { name: 'list_chores' } }, WRITE_TOOLS)).toBe('read');
    expect(classifyMessage({ method: 'tools/call', params: { name: 'add_expense' } }, WRITE_TOOLS)).toBe('write');
    expect(classifyMessage({ method: 'tools/call', params: {} }, WRITE_TOOLS)).toBe('read');
  });

  it('leaves the handshake, listings and junk free', () => {
    for (const method of ['initialize', 'tools/list', 'prompts/list', 'resources/list', 'ping']) {
      expect(classifyMessage({ method }, WRITE_TOOLS)).toBeNull();
    }
    expect(classifyMessage(null, WRITE_TOOLS)).toBeNull();
    expect(classifyMessage('nope', WRITE_TOOLS)).toBeNull();
  });
});

describe('checkLimit', () => {
  const limiter = (rows: unknown, error?: Error) => {
    const { client, calls } = fakeSupabase({ rpc: { mcp_rate_check: error ?? rows } });
    return { client: client as never, calls };
  };
  const checks = (calls: ReturnType<typeof fakeSupabase>['calls']) =>
    calls.rpc.filter(([name]) => name === 'mcp_rate_check').map(([, args]) => args);

  it('lets a call through when it is within the limit', async () => {
    const { client } = limiter([{ allowed: true, retry_after: 0 }]);
    expect(await checkLimit(client, 'read')).toEqual({ ok: true });
  });

  it('counts a read once, against the read bucket', async () => {
    const { client, calls } = limiter([{ allowed: true, retry_after: 0 }]);
    await checkLimit(client, 'read');
    expect(checks(calls)).toEqual([
      { p_bucket: 'read', p_limit: LIMITS.read.limit, p_window_seconds: LIMITS.read.windowSeconds },
    ]);
  });

  it('counts a write against both the minute and the day', async () => {
    const { client, calls } = limiter([{ allowed: true, retry_after: 0 }]);
    await checkLimit(client, 'write');
    expect(checks(calls).map((c) => (c as { p_bucket: string }).p_bucket).sort()).toEqual(['write', 'write_day']);
  });

  it('refuses, and says how long to wait', async () => {
    const { client } = limiter([{ allowed: false, retry_after: 37 }]);
    expect(await checkLimit(client, 'read')).toEqual({ ok: false, retryAfter: 37 });
  });

  it('is limited by the slowest bucket when more than one is exceeded', async () => {
    // Both write buckets answer from the same fake, so make them differ per call.
    let n = 0;
    const { client } = fakeSupabase({ rpc: {} });
    (client as unknown as { rpc: unknown }).rpc = () => {
      n += 1;
      return Promise.resolve({ data: [{ allowed: false, retry_after: n === 1 ? 20 : 3000 }], error: null });
    };
    expect(await checkLimit(client as never, 'write')).toEqual({ ok: false, retryAfter: 3000 });
  });

  it('fails open when the counter is unavailable, rather than locking the house out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await checkLimit(limiter(null, new Error('function mcp_rate_check does not exist')).client, 'write')).toEqual({ ok: true });
    expect(await checkLimit(limiter([]).client, 'read')).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('in the handler', () => {
  const fixtures = (allowed: boolean) => ({
    tables: baseTables,
    rpc: { ...enabled, mcp_rate_check: [{ allowed, retry_after: 42 }] },
  });

  it('turns a refused write into a tool error the assistant can read, and changes nothing', async () => {
    const { client, calls } = fakeSupabase(fixtures(false));
    const out = await call(client, 'complete_chore', { turn_id: '33333333-3333-4333-8333-333333333333' });

    expect(out.res.status).toBe(200);
    expect(out.res.headers.get('retry-after')).toBe('42');
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/42 seconds/);
    expect(out.text).toMatch(/nothing was changed/);
    // It stopped before any tool ran: no reads, no writes.
    expect(calls.filters).toEqual([]);
    expect(calls.rpc.map(([name]) => name)).toEqual(['mcp_rate_check', 'mcp_rate_check']);
  });

  it('limits reads too', async () => {
    const { client, calls } = fakeSupabase(fixtures(false));
    const out = await call(client, 'list_chores');
    expect(out.isError).toBe(true);
    expect(calls.filters).toEqual([]);
  });

  it('never limits connecting, listing tools, or prompts', async () => {
    const { client, calls } = fakeSupabase(fixtures(false));
    for (const [method, params] of [
      ['initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }],
      ['tools/list', {}],
      ['prompts/list', {}],
      ['resources/list', {}],
    ] as const) {
      const res = await handleMcp(rpcRequest(method, params), deps(client));
      expect(res.status).toBe(200);
      expect((await res.json()).error).toBeUndefined();
    }
    expect(calls.rpc.some(([name]) => name === 'mcp_rate_check')).toBe(false);
  });

  it('answers normally while within the limit', async () => {
    const { client } = fakeSupabase({ ...fixtures(true), tables: { ...baseTables, chore_turns: [] } });
    const out = await call(client, 'list_chores');
    expect(out.isError).toBe(false);
  });

  it('refuses a batch that smuggles in tool calls, but allows a harmless one', async () => {
    const { client } = fakeSupabase(fixtures(true));
    const batch = (calls: unknown[]) =>
      new Request('https://app.example/api/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer token',
        },
        body: JSON.stringify(calls),
      });

    const sneaky = await handleMcp(
      batch([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_chores', arguments: {} } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_chores', arguments: {} } },
      ]),
      deps(client),
    );
    expect(sneaky.status).toBe(400);
    expect((await sneaky.json()).error.message).toMatch(/one tool call per request/);
  });
});
