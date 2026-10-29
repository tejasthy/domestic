import type { SupabaseClient } from '@supabase/supabase-js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { formatCents, simplifyDebts } from '@/lib/money';
import { bucketFor } from '@/lib/rotation';
import type { ModuleKey } from '@/lib/modules';
import type { Balance, Database } from '@/lib/types';

/**
 * The tools an assistant gets. Every one runs through `ctx.supabase`, a client
 * carrying the signed-in person's own token, so RLS decides what is visible
 * and `complete_turn` / `flag_on_demand` see the real `auth.uid()`. Nothing
 * here may use the admin client.
 */

export type McpContext = {
  supabase: SupabaseClient<Database>;
  userId: string;
  /** Web push to housemates; injected so this file stays free of server-only code. */
  notify: (
    profileIds: string[],
    payload: { title: string; body: string; url?: string; tag?: string },
  ) => Promise<unknown>;
};

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

const fail = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

type Scope = {
  me: { id: string; full_name: string; is_admin: boolean };
  household: { id: string; name: string; timezone: string };
  modules: string[];
};

/**
 * Who is asking, which house they live in, and whether that house has let
 * assistants in. Checked on every call, so an admin switching the module off
 * takes effect at once rather than when a token happens to expire.
 */
async function scopeFor(ctx: McpContext, needs?: ModuleKey): Promise<Scope | { error: string }> {
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

type MemberRow = { id: string; full_name: string; initials: string };

async function members(ctx: McpContext, householdId: string): Promise<MemberRow[]> {
  const { data } = await ctx.supabase
    .from('profiles')
    .select('id, full_name, initials')
    .eq('household_id', householdId)
    .order('initials')
    .returns<MemberRow[]>();
  return data ?? [];
}

/* ------------------------------------------------------------------ reading */

export async function getHousehold(ctx: McpContext): Promise<CallToolResult> {
  const scope = await scopeFor(ctx);
  if ('error' in scope) return fail(scope.error);

  const [people, { data: away }] = await Promise.all([
    members(ctx, scope.household.id),
    ctx.supabase
      .from('member_away')
      .select('profile_id, starts_at, ends_at')
      .eq('household_id', scope.household.id)
      .or(`ends_at.is.null,ends_at.gt.${new Date().toISOString()}`)
      .returns<{ profile_id: string; starts_at: string; ends_at: string | null }[]>(),
  ]);
  const awayBy = new Map((away ?? []).map((a) => [a.profile_id, a]));

  return ok({
    household: scope.household.name,
    timezone: scope.household.timezone,
    you: { id: scope.me.id, name: scope.me.full_name, is_admin: scope.me.is_admin },
    modules: scope.modules.filter((m) => m !== 'mcp'),
    members: people.map((p) => ({
      id: p.id,
      name: p.full_name,
      initials: p.initials,
      away: awayBy.has(p.id)
        ? { since: awayBy.get(p.id)!.starts_at, until: awayBy.get(p.id)!.ends_at }
        : null,
    })),
  });
}

type UpNextRow = {
  id: string;
  chore_id: string;
  assignee_id: string;
  due_at: string | null;
  flagged_at: string | null;
  chore: { name: string; emoji: string; cadence: string };
  assignee: { full_name: string; initials: string };
};

/** One pending turn per chore — "who's up" — the same view as the Today screen. */
export async function listChores(
  ctx: McpContext,
  args: { mine_only?: boolean },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const { data, error } = await ctx.supabase
    .from('chore_turns')
    .select(`
      id, chore_id, assignee_id, due_at, flagged_at,
      chore:chores!inner ( name, emoji, cadence ),
      assignee:profiles!chore_turns_assignee_id_fkey ( full_name, initials )
    `)
    .eq('status', 'pending')
    .order('turn_number', { ascending: true })
    .limit(500)
    .returns<UpNextRow[]>();
  if (error) return fail('Could not load the chores.');

  const seen = new Set<string>();
  const upNext = (data ?? []).filter((t) => {
    if (seen.has(t.chore_id)) return false;
    seen.add(t.chore_id);
    return !args.mine_only || t.assignee_id === ctx.userId;
  });

  return ok({
    chores: upNext.map((t) => ({
      turn_id: t.id,
      chore_id: t.chore_id,
      chore: t.chore.name,
      emoji: t.chore.emoji,
      cadence: t.chore.cadence,
      up: { id: t.assignee_id, name: t.assignee.full_name },
      is_you: t.assignee_id === ctx.userId,
      due_at: t.due_at,
      // overdue | today | tomorrow | upcoming | anytime, in the house's own timezone.
      when: bucketFor(t.due_at, scope.household.timezone),
      flagged: t.flagged_at !== null,
    })),
  });
}

export async function getBalances(ctx: McpContext): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'expenses');
  if ('error' in scope) return fail(scope.error);

  const [people, { data, error }] = await Promise.all([
    members(ctx, scope.household.id),
    ctx.supabase.from('v_balances').select('*').returns<Balance[]>(),
  ]);
  if (error) return fail('Could not load the balances.');

  const net = Object.fromEntries((data ?? []).map((b) => [b.profile_id, Number(b.net_cents)]));
  const nameOf = new Map(people.map((p) => [p.id, p.full_name]));

  return ok({
    // Integer cents are the source of truth; the strings are for reading aloud.
    note: 'Positive net means the household owes that person. Amounts in cents.',
    balances: people.map((p) => ({
      id: p.id,
      name: p.full_name,
      net_cents: net[p.id] ?? 0,
      net: formatCents(net[p.id] ?? 0),
    })),
    settle_up: simplifyDebts(net).map((t) => ({
      from: nameOf.get(t.from) ?? t.from,
      to: nameOf.get(t.to) ?? t.to,
      cents: t.cents,
      amount: formatCents(t.cents),
    })),
  });
}

export async function recentActivity(
  ctx: McpContext,
  args: { limit?: number },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx);
  if ('error' in scope) return fail(scope.error);

  const { data, error } = await ctx.supabase
    .from('activity_log')
    .select('summary, created_at')
    .eq('household_id', scope.household.id)
    .order('created_at', { ascending: false })
    .limit(args.limit ?? 10)
    .returns<{ summary: string; created_at: string }[]>();
  if (error) return fail('Could not load recent activity.');

  return ok({ activity: (data ?? []).map((a) => ({ at: a.created_at, summary: a.summary })) });
}

/* ------------------------------------------------------------------ writing */

export async function completeChore(
  ctx: McpContext,
  args: { turn_id: string; note?: string },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const { data: turn } = await ctx.supabase
    .from('chore_turns')
    .select('id, chore_id, assignee_id, chore:chores(name, emoji)')
    .eq('id', args.turn_id)
    .single<{
      id: string; chore_id: string; assignee_id: string;
      chore: { name: string; emoji: string };
    }>();
  if (!turn) return fail('No such turn in your household. Use list_chores for current turn ids.');

  // Postgres raises user-facing messages: not your turn, location required, etc.
  const { error } = await ctx.supabase.rpc('complete_turn', {
    p_turn: args.turn_id,
    p_note: args.note ?? null,
    p_lat: null,
    p_lon: null,
  });
  if (error) return fail(error.message);

  // Tell whoever is up next that the baton moved, as the app does.
  const { data: next } = await ctx.supabase
    .from('chore_turns')
    .select('assignee_id')
    .eq('chore_id', turn.chore_id)
    .eq('status', 'pending')
    .order('turn_number')
    .limit(1)
    .single<{ assignee_id: string }>();
  if (next && next.assignee_id !== turn.assignee_id) {
    await ctx.notify([next.assignee_id], {
      title: `${turn.chore.emoji} You're up: ${turn.chore.name}`,
      body: 'The rotation just moved to you.',
      url: '/home',
      tag: `chore-${turn.chore_id}`,
    });
  }

  return ok({ ok: true, completed: turn.chore.name });
}

/** Match by id, exact name, or slug — so "dishes" or "recycling" is enough. */
export function matchChore<T extends { id: string; name: string }>(chores: T[], wanted: string): T | undefined {
  const needle = wanted.trim().toLowerCase();
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return chores.find(
    (c) => c.id === wanted.trim() || c.name.toLowerCase() === needle || slug(c.name) === slug(needle),
  );
}

export async function flagChore(
  ctx: McpContext,
  args: { chore: string },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const { data: chores } = await ctx.supabase
    .from('chores')
    .select('id, name, emoji')
    .eq('household_id', scope.household.id)
    .eq('is_active', true)
    .returns<{ id: string; name: string; emoji: string }[]>();

  const chore = matchChore(chores ?? [], args.chore);
  if (!chore) {
    return fail(
      `No chore called "${args.chore}". Known chores: ${(chores ?? []).map((c) => c.name).join(', ') || 'none'}.`,
    );
  }

  const { data, error } = await ctx.supabase
    .rpc('flag_on_demand', { p_chore: chore.id })
    .single<{ id: string; assignee_id: string }>();
  if (error) return fail(error.message);

  if (data?.assignee_id) {
    await ctx.notify([data.assignee_id], {
      title: `${chore.emoji} ${chore.name} — you're up`,
      body: 'Someone flagged it for you.',
      url: '/home',
      tag: `chore-${chore.id}`,
    });
  }

  return ok({ ok: true, flagged: chore.name, turn_id: data?.id ?? null });
}

/* ------------------------------------------------------------------- server */

/** Runs a handler, turning anything unexpected into a tool error, never a 500. */
async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    console.error('[mcp] tool failed', error instanceof Error ? error.message : error);
    return fail('Something went wrong on the Domestic side. Try again in a moment.');
  }
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

export function buildServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'domestic', title: 'Domestic', version: '1.0.0' },
    {
      instructions:
        'Domestic tracks chores and shared expenses for one household. Call get_household first to learn ' +
        'who lives there. Money is integer cents. Only complete or flag a chore when the person asked you to.',
    },
  );

  server.registerTool(
    'get_household',
    {
      title: 'Household and members',
      description: 'The household, who the signed-in person is, who lives there, and who is away.',
      annotations: READ,
    },
    () => guarded(() => getHousehold(ctx)),
  );

  server.registerTool(
    'list_chores',
    {
      title: "Who's up for each chore",
      description:
        'The current turn for every chore: who is up, when it is due, and whether it was flagged. ' +
        'Returns the turn_id that complete_chore needs.',
      inputSchema: { mine_only: z.boolean().optional().describe('Only the signed-in person’s turns') },
      annotations: READ,
    },
    (args) => guarded(() => listChores(ctx, args)),
  );

  server.registerTool(
    'get_balances',
    {
      title: 'Shared-expense balances',
      description: 'Who is owed money and who owes it, plus the fewest transfers that settle everyone up.',
      annotations: READ,
    },
    () => guarded(() => getBalances(ctx)),
  );

  server.registerTool(
    'recent_activity',
    {
      title: 'Recent activity',
      description: 'The latest things that happened in the house: chores done, expenses added.',
      inputSchema: { limit: z.number().int().min(1).max(25).optional() },
      annotations: READ,
    },
    (args) => guarded(() => recentActivity(ctx, args)),
  );

  server.registerTool(
    'complete_chore',
    {
      title: 'Mark a chore done',
      description:
        'Marks a turn done as the signed-in person. Only works where the app itself would allow it: ' +
        'it is their turn (or the house lets anyone complete anyone’s), and not blocked by a location rule.',
      inputSchema: {
        turn_id: z.string().uuid().describe('From list_chores'),
        note: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    (args) => guarded(() => completeChore(ctx, args)),
  );

  server.registerTool(
    'flag_chore',
    {
      title: 'Flag a chore as needing doing',
      description:
        'The “dishwasher is full” button: surfaces the chore and notifies whoever is up. ' +
        'Accepts a chore name such as "dishes".',
      inputSchema: { chore: z.string().min(1).max(80) },
      annotations: WRITE,
    },
    (args) => guarded(() => flagChore(ctx, args)),
  );

  return server;
}
