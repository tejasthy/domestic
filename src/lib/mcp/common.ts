import type { SupabaseClient } from '@supabase/supabase-js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { formatCents } from '@/lib/money';
import type { ModuleKey } from '@/lib/modules';
import type { Database } from '@/lib/types';
import { isCalendarDay, resolvePerson, type Person } from './ledger';

/**
 * Shared by every MCP tool. Each one runs through `ctx.supabase`, a client
 * carrying the signed-in person's own token, so RLS decides what is visible
 * and `complete_turn` / `flag_on_demand` see the real `auth.uid()`. Nothing in
 * lib/mcp may use the admin client.
 */

export type McpContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
  /** Web push to housemates; injected so this code stays free of server-only imports. */
  notify: (
    profileIds: string[],
    payload: { title: string; body: string; url?: string; tag?: string },
  ) => Promise<unknown>;
};

export const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

export const fail = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

export type Scope = {
  me: { id: string; full_name: string; is_admin: boolean };
  household: { id: string; name: string; timezone: string };
  modules: string[];
};

/**
 * Who is asking, which house they live in, and whether that house has let
 * assistants in. Checked on every call, so an admin switching the module off
 * takes effect at once rather than when a token happens to expire.
 */
export async function scopeFor(
  ctx: McpContext,
  needs?: ModuleKey,
): Promise<Scope | { error: string }> {
  const { data: me } = await ctx.supabase
    .from('profiles')
    .select('id, household_id, full_name, is_admin')
    .eq('id', ctx.userId)
    .single<{ id: string; household_id: string | null; full_name: string; is_admin: boolean }>();
  if (!me?.household_id) return { error: 'This account is not in a household yet.' };

  const [{ data: household }, { data: modules }] = await Promise.all([
    ctx.supabase
      .from('households')
      .select('id, name, timezone')
      .eq('id', me.household_id)
      .single<Scope['household']>(),
    ctx.supabase.rpc('enabled_modules', { p_household: me.household_id }),
  ]);

  // Fails closed: unlike the app, a missing answer must not fall back to defaults.
  const enabled = (modules as string[] | null) ?? [];
  if (!household || !enabled.includes('mcp')) {
    return {
      error:
        'AI assistant access is switched off for this household. An admin can turn it on under Settings → Household.',
    };
  }
  if (needs && !enabled.includes(needs)) {
    return { error: `This household does not use the ${needs} module.` };
  }

  return { me: { id: me.id, full_name: me.full_name, is_admin: me.is_admin }, household, modules: enabled };
}

export type MemberRow = { id: string; full_name: string; initials: string };

export async function members(ctx: McpContext, householdId: string): Promise<MemberRow[]> {
  const { data } = await ctx.supabase
    .from('profiles')
    .select('id, full_name, initials')
    .eq('household_id', householdId)
    .order('initials')
    .returns<MemberRow[]>();
  return data ?? [];
}

/** Match by id, exact name, or slug — so "dishes" or "recycling" is enough. */
export function matchChore<T extends { id: string; name: string }>(chores: T[], wanted: string): T | undefined {
  const needle = wanted.trim().toLowerCase();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return chores.find(
    (c) => c.id === wanted.trim() || c.name.toLowerCase() === needle || slug(c.name) === slug(needle),
  );
}

/** Runs a handler, turning anything unexpected into a tool error, never a 500. */
export async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    console.error('[mcp] tool failed', error instanceof Error ? error.message : error);
    return fail('Something went wrong on the Domestic side. Try again in a moment.');
  }
}

export const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

/** A calendar day, validated, so "2026-02-30" is refused before any query runs. */
export const day = z
  .string()
  .refine(isCalendarDay, 'Use a real date written YYYY-MM-DD')
  .describe('YYYY-MM-DD, in the house’s timezone');

/**
 * Every tool that can change something. The rate limiter holds these to a
 * tighter budget than reads, and a test checks this list against each tool's
 * own `readOnlyHint` so a new write tool cannot slip past it unmetered.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'complete_chore', 'flag_chore',
  'request_swap', 'respond_to_swap', 'set_away', 'clear_away', 'post_kiosk_message',
  'add_expense', 'add_itemized_expense', 'record_payment', 'request_settle_up',
]);

/** Resolves several names (or "me") to profile ids, failing on the first that does not match. */
export function resolveMany(
  people: Person[],
  names: string[],
  selfId: string,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids: string[] = [];
  for (const name of names) {
    const found = resolvePerson(people, name, selfId);
    if ('error' in found) return { ok: false, error: found.error };
    if (!ids.includes(found.id)) ids.push(found.id);
  }
  return { ok: true, ids };
}

/** Profile id -> display name, with a stand-in for someone who has since left the house. */
export const nameOf = (people: Person[]) => {
  const byId = new Map(people.map((p) => [p.id, p.full_name]));
  return (id: string | null) => (id ? (byId.get(id) ?? 'Former housemate') : null);
};

export const money = (cents: number) => ({ cents, amount: formatCents(cents) });
