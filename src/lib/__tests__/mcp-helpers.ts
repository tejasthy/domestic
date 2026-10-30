import { vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleMcp } from '../mcp/handler';

export const ME = '11111111-1111-4111-8111-111111111111';
export const ANA = '22222222-2222-4222-8222-222222222222';
export const BEN = '33333333-3333-4333-8333-333333333333';
export const HOUSE = '99999999-9999-4999-8999-999999999999';

export const PEOPLE = [
  { id: ME, household_id: HOUSE, full_name: 'Tejas Thiyagarajan', initials: 'TT', is_admin: true },
  { id: ANA, household_id: HOUSE, full_name: 'Aiden Brooks', initials: 'AB', is_admin: false },
  { id: BEN, household_id: HOUSE, full_name: 'Brandon Kauten', initials: 'BK', is_admin: false },
];

export const baseTables = {
  profiles: PEOPLE,
  households: [{ id: HOUSE, name: '526 Detroit St.', timezone: 'America/Detroit' }],
};

export const enabled = { enabled_modules: ['mcp', 'chores', 'expenses', 'kiosk'] };

export function rpcRequest(method: string, params: unknown = {}, id = 1) {
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

/** A push-notification spy whose calls can be inspected: who was told, and what. */
export const notifySpy = () =>
  vi.fn<(ids: string[], payload: { title: string; body: string; url?: string; tag?: string }) => Promise<undefined>>(
    async () => undefined,
  );

export const deps = (supabase: SupabaseClient, notify: ReturnType<typeof notifySpy> = notifySpy()) => ({
  authenticate: async () => ({ userId: ME, clientId: 'test', supabase: supabase as never }),
  notify,
});

const safeJson = (t: string) => {
  try { return JSON.parse(t); } catch { return null; }
};

/** Calls one tool through the real handler and unpacks the result. */
export async function call(
  supabase: SupabaseClient,
  name: string,
  args: Record<string, unknown> = {},
  notify: ReturnType<typeof notifySpy> = notifySpy(),
) {
  const res = await handleMcp(rpcRequest('tools/call', { name, arguments: args }), deps(supabase, notify));
  const body = await res.json();
  const text: string | undefined = body.result?.content?.[0]?.text;
  const isError = !!body.result?.isError || !!body.error;
  return { res, body, text, isError, data: text && !isError ? safeJson(text) : null, notify };
}
