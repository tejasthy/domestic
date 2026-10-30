import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { fromZonedTime } from 'date-fns-tz';
import { z } from 'zod';
import {
  READ, WRITE, day, fail, guarded, members, nameOf, ok, scopeFor, type McpContext,
} from './common';
import { localDay, resolvePerson } from './ledger';

/**
 * Housemate-to-housemate coordination: swapping a turn, going away, and
 * leaving a note on the wall display. Each calls the same database functions,
 * or makes the same inserts, as the app does, so the same rules apply.
 */

type SwapRow = {
  id: string;
  requested_by: string;
  requested_to: string;
  status: string;
  message: string | null;
  created_at: string;
  turn: { id: string; due_at: string | null; chore: { name: string; emoji: string } } | null;
};

export async function listSwaps(
  ctx: McpContext,
  args: { include_resolved?: boolean },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  let query = ctx.supabase
    .from('chore_swaps')
    .select(`
      id, requested_by, requested_to, status, message, created_at,
      turn:chore_turns ( id, due_at, chore:chores ( name, emoji ) )
    `)
    // ctx.userId is the verified token's subject, a UUID, never caller text.
    .or(`requested_by.eq.${ctx.userId},requested_to.eq.${ctx.userId}`);
  if (!args.include_resolved) query = query.eq('status', 'pending');

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(25)
    .returns<SwapRow[]>();
  if (error) return fail('Could not load the swaps.');

  return ok({
    swaps: (data ?? []).map((s) => ({
      swap_id: s.id,
      direction: s.requested_to === ctx.userId ? 'asked_of_you' : 'asked_by_you',
      status: s.status,
      chore: s.turn?.chore.name ?? 'a chore',
      due_at: s.turn?.due_at ?? null,
      from: name(s.requested_by),
      to: name(s.requested_to),
      ...(s.message ? { message: s.message } : {}),
      asked_on: localDay(s.created_at, scope.household.timezone),
    })),
  });
}

export async function requestSwap(
  ctx: McpContext,
  args: { turn_id: string; with: string; message?: string },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  const other = resolvePerson(people, args.with, ctx.userId);
  if ('error' in other) return fail(other.error);
  if (other.id === ctx.userId) return fail("You can't swap with yourself.");

  const { data: turn } = await ctx.supabase
    .from('chore_turns')
    .select('id, assignee_id, status, chore_id, chore:chores ( name, emoji )')
    .eq('id', args.turn_id)
    .single<{
      id: string; assignee_id: string; status: string; chore_id: string;
      chore: { name: string; emoji: string };
    }>();
  if (!turn) return fail('No such turn in your household. Use list_chores for current turn ids.');
  if (turn.assignee_id !== ctx.userId) return fail('That turn is not yours, so you cannot offer to swap it.');
  if (turn.status !== 'pending') return fail('That turn is already finished.');

  const { data: open } = await ctx.supabase
    .from('chore_swaps')
    .select('id')
    .eq('turn_id', turn.id)
    .eq('status', 'pending')
    .limit(1)
    .returns<{ id: string }[]>();
  if ((open ?? []).length > 0) return fail('There is already an open swap request for that turn.');

  const { data: swap, error } = await ctx.supabase
    .from('chore_swaps')
    .insert({
      turn_id: turn.id,
      requested_by: ctx.userId,
      requested_to: other.id,
      message: args.message ?? null,
    })
    .select('id')
    .single<{ id: string }>();
  if (error || !swap) return fail(error?.message ?? 'Could not send the swap request.');

  await ctx.notify([other.id], {
    title: 'Chore swap request',
    body: `${scope.me.full_name} wants to swap a turn with you.`,
    url: '/chores',
    tag: `swap-${turn.id}`,
  });

  return ok({ ok: true, swap_id: swap.id, asked: name(other.id), chore: turn.chore.name });
}

export async function respondToSwap(
  ctx: McpContext,
  args: { swap_id: string; accept: boolean },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const { data: swap } = await ctx.supabase
    .from('chore_swaps')
    .select('id, requested_to, status')
    .eq('id', args.swap_id)
    .single<{ id: string; requested_to: string; status: string }>();
  if (!swap) return fail('No such swap request. Use list_swaps for current ids.');
  if (swap.requested_to !== ctx.userId) return fail('Only the person the swap was offered to can answer it.');
  if (swap.status !== 'pending') return fail(`That swap was already ${swap.status}.`);

  if (args.accept) {
    const { error } = await ctx.supabase.rpc('accept_swap', { p_swap: swap.id });
    if (error) return fail(error.message);
  } else {
    const { error } = await ctx.supabase
      .from('chore_swaps')
      .update({ status: 'declined', resolved_at: new Date().toISOString() })
      .eq('id', swap.id);
    if (error) return fail(error.message);
  }

  return ok({ ok: true, swap_id: swap.id, result: args.accept ? 'accepted' : 'declined' });
}

export async function setAway(ctx: McpContext, args: { until?: string }): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const tz = scope.household.timezone;
  let until: string | null = null;
  if (args.until) {
    // Back at the start of that day, house time — and it has to be a future day.
    if (args.until <= localDay(new Date(), tz)) return fail('The return date must be after today.');
    until = fromZonedTime(`${args.until}T00:00:00`, tz).toISOString();
  }

  const { error } = await ctx.supabase.rpc('set_away', { p_until: until });
  if (error) return fail(error.message);

  return ok({
    ok: true,
    away: true,
    until: args.until ?? null,
    note: 'You are skipped in every chore rotation until you are back.',
  });
}

export async function clearAway(ctx: McpContext): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const { error } = await ctx.supabase.rpc('clear_away');
  if (error) return fail(error.message);
  return ok({ ok: true, away: false, note: 'You are back in the rotation.' });
}

export async function postKioskMessage(
  ctx: McpContext,
  args: { body: string },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'kiosk');
  if ('error' in scope) return fail(scope.error);

  const body = args.body.trim();
  if (!body) return fail('Say something first.');

  const { error } = await ctx.supabase.from('kiosk_messages').insert({
    household_id: scope.household.id,
    author_id: ctx.userId,
    body,
  });
  if (error) return fail(error.message);

  return ok({ ok: true, posted: body, note: 'It shows on the wall display for about two days.' });
}

/* ------------------------------------------------------------- registration */

export function registerCoordinationTools(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'list_swaps',
    {
      title: 'Chore swap requests',
      description: 'Swap requests involving the signed-in person: ones asked of them and ones they asked. Pending by default.',
      inputSchema: { include_resolved: z.boolean().optional() },
      annotations: READ,
    },
    (args) => guarded(() => listSwaps(ctx, args)),
  );

  server.registerTool(
    'request_swap',
    {
      title: 'Ask a housemate to swap a turn',
      description:
        'Offers the signed-in person’s own pending turn to a housemate. Takes a turn_id from list_chores. ' +
        'Nothing changes until the other person accepts.',
      inputSchema: {
        turn_id: z.string().uuid().describe('From list_chores; must be the signed-in person’s own turn'),
        with: z.string().min(1).max(80).describe('Who to ask'),
        message: z.string().max(280).optional(),
      },
      annotations: WRITE,
    },
    (args) => guarded(() => requestSwap(ctx, args)),
  );

  server.registerTool(
    'respond_to_swap',
    {
      title: 'Accept or decline a swap',
      description: 'Answers a swap that was asked of the signed-in person. Takes a swap_id from list_swaps.',
      inputSchema: { swap_id: z.string().uuid(), accept: z.boolean() },
      annotations: WRITE,
    },
    (args) => guarded(() => respondToSwap(ctx, args)),
  );

  server.registerTool(
    'set_away',
    {
      title: 'Mark the signed-in person away',
      description:
        'Skips them in every chore rotation until they are back. Give a return date if known (YYYY-MM-DD, ' +
        'a future day); without one they stay away until they clear it.',
      inputSchema: { until: day.optional() },
      annotations: WRITE,
    },
    (args) => guarded(() => setAway(ctx, args)),
  );

  server.registerTool(
    'clear_away',
    {
      title: 'Mark the signed-in person back',
      description: 'Ends their away period early and puts them back in the rotation.',
      annotations: WRITE,
    },
    () => guarded(() => clearAway(ctx)),
  );

  server.registerTool(
    'post_kiosk_message',
    {
      title: 'Leave a note on the wall display',
      description: 'Posts a short note (up to 280 characters) that shows on the kitchen display for about two days.',
      inputSchema: { body: z.string().min(1).max(280) },
      annotations: WRITE,
    },
    (args) => guarded(() => postKioskMessage(ctx, args)),
  );
}
