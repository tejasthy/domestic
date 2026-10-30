import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  READ, day, fail, guarded, matchChore, members, money, nameOf, ok, scopeFor, type McpContext,
} from './common';
import {
  dayBoundsUtc, describeRecurrence, escapeLike, involves, localDay,
  resolvePerson, summarizeExpenses, tallyTurns,
} from './ledger';

/**
 * The read-only history behind the activity feed: the expense ledger down to
 * line items, settlements, recurring bills, and who did which chore when. All
 * of it is visible to any member under RLS; nothing here writes.
 */

/** Rows pulled before totalling. More than this and the result says so. */
const SCAN_LIMIT = 300;

type Share = { profile_id: string; owed_cents: number };

/* ----------------------------------------------------------------- expenses */

type ExpenseRow = {
  id: string;
  description: string;
  amount_cents: number;
  category: string;
  paid_by: string;
  spent_on: string;
  split_kind: string;
  note: string | null;
  splits: Share[];
  items: { id: string }[];
};

export async function listExpenses(
  ctx: McpContext,
  args: {
    since?: string; until?: string; paid_by?: string; involving?: string;
    category?: string; search?: string; limit?: number; include_shares?: boolean;
  },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'expenses');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  const resolve = (wanted: string | undefined) => {
    if (!wanted) return { id: undefined };
    return resolvePerson(people, wanted, ctx.userId);
  };
  const payer = resolve(args.paid_by);
  if ('error' in payer) return fail(payer.error);
  const involved = resolve(args.involving);
  if ('error' in involved) return fail(involved.error);

  let query = ctx.supabase
    .from('expenses')
    .select(`
      id, description, amount_cents, category, paid_by, spent_on, split_kind, note,
      splits:expense_splits ( profile_id, owed_cents ),
      items:expense_items ( id )
    `)
    .is('deleted_at', null);
  if (args.since) query = query.gte('spent_on', args.since);
  if (args.until) query = query.lte('spent_on', args.until);
  if (payer.id) query = query.eq('paid_by', payer.id);
  if (args.category) query = query.ilike('category', escapeLike(args.category));
  if (args.search) query = query.ilike('description', `%${escapeLike(args.search)}%`);

  const { data, error } = await query
    .order('spent_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(SCAN_LIMIT)
    .returns<ExpenseRow[]>();
  if (error) return fail('Could not load the expenses.');

  const scanned = data ?? [];
  const rows = involved.id ? scanned.filter((e) => involves(e, involved.id!)) : scanned;
  const summary = summarizeExpenses(rows);
  const limit = args.limit ?? 25;

  return ok({
    note: 'All amounts are integer cents. Totals cover every matching expense, not just those listed.',
    range: { since: args.since ?? null, until: args.until ?? null },
    matched: rows.length,
    showing: Math.min(rows.length, limit),
    // Past the scan limit the totals would silently undercount; say so instead.
    complete: scanned.length < SCAN_LIMIT,
    total: money(summary.total_cents),
    by_person: summary.by_person.map((p) => ({
      id: p.id,
      name: name(p.id),
      paid: money(p.paid_cents),
      share: money(p.share_cents),
      paid_for_others: money(p.paid_for_others_cents),
      others_paid_for_me: money(p.others_paid_for_me_cents),
    })),
    by_category: summary.by_category.map((c) => ({ category: c.category, ...money(c.cents) })),
    expenses: rows.slice(0, limit).map((e) => ({
      id: e.id,
      description: e.description,
      ...money(e.amount_cents),
      category: e.category,
      spent_on: e.spent_on,
      paid_by: { id: e.paid_by, name: name(e.paid_by) },
      split_kind: e.split_kind,
      // An itemized expense was split line by line; get_expense shows the lines.
      itemized: e.split_kind === 'itemized',
      item_count: e.items.length,
      ...(e.note ? { note: e.note } : {}),
      ...(args.include_shares
        ? { shares: e.splits.map((s) => ({ person: name(s.profile_id), ...money(s.owed_cents) })) }
        : {}),
    })),
  });
}

type ItemRow = {
  id: string;
  name: string;
  amount_cents: number;
  kind: string;
  split_kind: string;
  position: number;
  item_splits: Share[];
};

type ExpenseDetailRow = Omit<ExpenseRow, 'splits' | 'items'> & {
  created_at: string;
  splits: (Share & { weight: number | null })[];
  items: ItemRow[];
};

export async function getExpenseDetail(
  ctx: McpContext,
  args: { expense_id: string },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'expenses');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  const { data: e } = await ctx.supabase
    .from('expenses')
    .select(`
      id, description, amount_cents, category, paid_by, spent_on, split_kind, note, created_at,
      splits:expense_splits ( profile_id, owed_cents, weight ),
      items:expense_items (
        id, name, amount_cents, kind, split_kind, position,
        item_splits:expense_item_splits ( profile_id, owed_cents )
      )
    `)
    .eq('id', args.expense_id)
    .is('deleted_at', null)
    .single<ExpenseDetailRow>();
  if (!e) return fail('No such expense in your household. Use list_expenses for current ids.');

  const items = [...e.items].sort((a, b) => a.position - b.position);
  const sharesTotal = e.splits.reduce((sum, s) => sum + s.owed_cents, 0);

  return ok({
    note: 'All amounts are integer cents.',
    id: e.id,
    description: e.description,
    ...money(e.amount_cents),
    category: e.category,
    spent_on: e.spent_on,
    paid_by: { id: e.paid_by, name: name(e.paid_by) },
    // 'itemized' means the shares below were rolled up from the line items.
    split_kind: e.split_kind,
    itemized: e.split_kind === 'itemized',
    ...(e.note ? { note_text: e.note } : {}),
    shares: e.splits.map((s) => ({
      person: name(s.profile_id),
      ...money(s.owed_cents),
      ...(s.weight !== null ? { weight: s.weight } : {}),
    })),
    shares_add_up: sharesTotal === e.amount_cents,
    items: items.map((i) => ({
      name: i.name,
      // item | tax | tip | discount | fee
      kind: i.kind,
      ...money(i.amount_cents),
      split_kind: i.split_kind,
      shares: i.item_splits.map((s) => ({ person: name(s.profile_id), ...money(s.owed_cents) })),
    })),
  });
}

/* -------------------------------------------------------------- settlements */

export async function listSettlements(
  ctx: McpContext,
  args: { since?: string; until?: string; person?: string; limit?: number },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'expenses');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  let personId: string | undefined;
  if (args.person) {
    const who = resolvePerson(people, args.person, ctx.userId);
    if ('error' in who) return fail(who.error);
    personId = who.id;
  }

  let query = ctx.supabase
    .from('settlements')
    .select('id, from_profile, to_profile, amount_cents, settled_on, method, note');
  if (args.since) query = query.gte('settled_on', args.since);
  if (args.until) query = query.lte('settled_on', args.until);
  // personId is one of this house's own profile ids, never caller-supplied text.
  if (personId) query = query.or(`from_profile.eq.${personId},to_profile.eq.${personId}`);

  const { data, error } = await query
    .order('settled_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(args.limit ?? 25)
    .returns<{
      id: string; from_profile: string; to_profile: string; amount_cents: number;
      settled_on: string; method: string; note: string | null;
    }[]>();
  if (error) return fail('Could not load the payments.');

  const rows = data ?? [];
  return ok({
    note: 'Payments between housemates that settle up shared expenses. Amounts in cents.',
    showing: rows.length,
    total: money(rows.reduce((sum, s) => sum + s.amount_cents, 0)),
    settlements: rows.map((s) => ({
      settled_on: s.settled_on,
      from: name(s.from_profile),
      to: name(s.to_profile),
      ...money(s.amount_cents),
      method: s.method,
      ...(s.note ? { note: s.note } : {}),
    })),
  });
}

/* ---------------------------------------------------------------- recurring */

export async function listRecurringExpenses(
  ctx: McpContext,
  args: { include_inactive?: boolean },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'expenses');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  let query = ctx.supabase
    .from('recurring_expenses')
    .select(`
      id, description, amount_cents, category, paid_by, split_kind, cadence, interval_weeks,
      interval_months, day_of_month, next_run_on, is_active,
      participants:recurring_expense_participants ( profile_id, owed_cents )
    `);
  if (!args.include_inactive) query = query.eq('is_active', true);

  const { data, error } = await query
    .order('next_run_on', { ascending: true })
    .limit(100)
    .returns<{
      id: string; description: string; amount_cents: number; category: string; paid_by: string;
      split_kind: string; cadence: 'weekly' | 'monthly'; interval_weeks: number; interval_months: number;
      day_of_month: number | null; next_run_on: string; is_active: boolean;
      participants: { profile_id: string; owed_cents: number }[];
    }[]>();
  if (error) return fail('Could not load the recurring expenses.');

  return ok({
    note: 'Bills that post on their own. Amounts in cents.',
    recurring: (data ?? []).map((r) => ({
      description: r.description,
      ...money(r.amount_cents),
      category: r.category,
      repeats: describeRecurrence(r),
      next_run_on: r.next_run_on,
      paid_by: name(r.paid_by),
      split_kind: r.split_kind,
      active: r.is_active,
      shares: r.participants.map((p) => ({ person: name(p.profile_id), ...money(p.owed_cents) })),
    })),
  });
}

/* ------------------------------------------------------------------- chores */

export async function choreHistory(
  ctx: McpContext,
  args: { since?: string; until?: string; person?: string; chore?: string; limit?: number },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const tz = scope.household.timezone;
  const [people, { data: chores }] = await Promise.all([
    members(ctx, scope.household.id),
    ctx.supabase
      .from('chores')
      .select('id, name')
      .eq('household_id', scope.household.id)
      .returns<{ id: string; name: string }[]>(),
  ]);
  const name = nameOf(people);

  let personId: string | undefined;
  if (args.person) {
    const who = resolvePerson(people, args.person, ctx.userId);
    if ('error' in who) return fail(who.error);
    personId = who.id;
  }
  let choreId: string | undefined;
  if (args.chore) {
    const found = matchChore(chores ?? [], args.chore);
    if (!found) {
      return fail(`No chore called "${args.chore}". Known chores: ${(chores ?? []).map((c) => c.name).join(', ') || 'none'}.`);
    }
    choreId = found.id;
  }

  const bounds = dayBoundsUtc(args.since, args.until, tz);
  let query = ctx.supabase
    .from('chore_turns')
    .select('id, chore_id, assignee_id, completed_by, completed_at, note, chore:chores!inner ( name, emoji )')
    .eq('status', 'done');
  if (bounds.from) query = query.gte('completed_at', bounds.from);
  if (bounds.before) query = query.lt('completed_at', bounds.before);
  if (personId) query = query.eq('completed_by', personId);
  if (choreId) query = query.eq('chore_id', choreId);

  const { data, error } = await query
    .order('completed_at', { ascending: false })
    .limit(args.limit ?? 25)
    .returns<{
      id: string; chore_id: string; assignee_id: string; completed_by: string | null;
      completed_at: string; note: string | null; chore: { name: string; emoji: string };
    }[]>();
  if (error) return fail('Could not load the chore history.');

  return ok({
    timezone: tz,
    showing: (data ?? []).length,
    completed: (data ?? []).map((t) => ({
      chore: t.chore.name,
      emoji: t.chore.emoji,
      done_by: name(t.completed_by ?? t.assignee_id),
      // Present only when someone covered another person's turn.
      ...(t.completed_by && t.completed_by !== t.assignee_id ? { covered_for: name(t.assignee_id) } : {}),
      date: localDay(t.completed_at, tz),
      at: t.completed_at,
      ...(t.note ? { note: t.note } : {}),
    })),
  });
}

/** Turns pulled for a ranged tally; past this the counts would undercount, so the result says so. */
const TURN_SCAN_LIMIT = 1000;

type TurnRef = { chore_id: string; assignee_id: string };

export async function choreStats(
  ctx: McpContext,
  args: { since?: string; until?: string },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'chores');
  if ('error' in scope) return fail(scope.error);

  const [people, { data: chores }] = await Promise.all([
    members(ctx, scope.household.id),
    ctx.supabase
      .from('chores')
      .select('id, name')
      .eq('household_id', scope.household.id)
      .returns<{ id: string; name: string }[]>(),
  ]);
  const choreName = new Map((chores ?? []).map((c) => [c.id, c.name]));

  if (args.since || args.until) {
    const bounds = dayBoundsUtc(args.since, args.until, scope.household.timezone);
    // A done turn is dated by when it was completed; a missed one never was, so by when it fell due.
    let doneQ = ctx.supabase.from('chore_turns').select('chore_id, assignee_id').eq('status', 'done');
    let missedQ = ctx.supabase.from('chore_turns').select('chore_id, assignee_id').eq('status', 'missed');
    if (bounds.from) {
      doneQ = doneQ.gte('completed_at', bounds.from);
      missedQ = missedQ.gte('due_at', bounds.from);
    }
    if (bounds.before) {
      doneQ = doneQ.lt('completed_at', bounds.before);
      missedQ = missedQ.lt('due_at', bounds.before);
    }
    const [{ data: done, error: doneError }, { data: missed, error: missedError }] = await Promise.all([
      doneQ.limit(TURN_SCAN_LIMIT).returns<TurnRef[]>(),
      missedQ.limit(TURN_SCAN_LIMIT).returns<TurnRef[]>(),
    ]);
    if (doneError || missedError) return fail('Could not load the chore stats.');

    const tallies = new Map(tallyTurns(done ?? [], missed ?? []).map((t) => [t.id, t]));
    return ok({
      note:
        'Turns completed and missed within the range, credited to whoever the turn belonged to ' +
        '(the same rule as the all-time tally). Housemates with none show 0.',
      range: { since: args.since ?? null, until: args.until ?? null },
      complete: (done ?? []).length < TURN_SCAN_LIMIT && (missed ?? []).length < TURN_SCAN_LIMIT,
      people: people.map((p) => {
        const t = tallies.get(p.id);
        return {
          name: p.full_name,
          done: t?.done ?? 0,
          missed: t?.missed ?? 0,
          by_chore: (t?.by_chore ?? [])
            .map((c) => ({ chore: choreName.get(c.chore_id) ?? 'Removed chore', done: c.done, missed: c.missed }))
            .sort((a, b) => b.done - a.done),
        };
      }),
    });
  }

  const { data: stats, error } = await ctx.supabase
    .from('v_chore_stats')
    .select('chore_id, profile_id, done_count, missed_count, last_done_at')
    .returns<{
      chore_id: string; profile_id: string; done_count: number; missed_count: number;
      last_done_at: string | null;
    }[]>();
  if (error) return fail('Could not load the chore stats.');

  const rows = stats ?? [];
  return ok({
    note: 'All-time turns completed and missed, per person and per chore. Pass since/until for a window.',
    people: people.map((p) => {
      const mine = rows.filter((r) => r.profile_id === p.id);
      return {
        name: p.full_name,
        done: mine.reduce((sum, r) => sum + Number(r.done_count), 0),
        missed: mine.reduce((sum, r) => sum + Number(r.missed_count), 0),
        by_chore: mine
          .map((r) => ({
            chore: choreName.get(r.chore_id) ?? 'Removed chore',
            done: Number(r.done_count),
            missed: Number(r.missed_count),
            last_done_at: r.last_done_at,
          }))
          .sort((a, b) => b.done - a.done),
      };
    }),
  });
}

/* ------------------------------------------------------------- registration */

export function registerLedgerTools(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'list_expenses',
    {
      title: 'Shared expenses, with totals',
      description:
        'The expense ledger, newest first, filterable by date, who paid, who was involved, category, or ' +
        'text. Also returns totals over EVERY matching expense: overall, per category, and per person — ' +
        'including paid_for_others (what a person covered for housemates) and others_paid_for_me. Use ' +
        'since/until for ranges like "last month". Set include_shares to see who owes what on each one.',
      inputSchema: {
        since: day.optional(),
        until: day.optional(),
        paid_by: z.string().max(80).optional().describe('Name, initials, or "me"'),
        involving: z.string().max(80).optional().describe('Expenses this person paid or owes a share of'),
        category: z.string().max(40).optional(),
        search: z.string().max(80).optional().describe('Text in the description, e.g. "Xfinity"'),
        limit: z.number().int().min(1).max(100).optional().describe('How many to list (default 25)'),
        include_shares: z.boolean().optional(),
      },
      annotations: READ,
    },
    (args) => guarded(() => listExpenses(ctx, args)),
  );

  server.registerTool(
    'get_expense',
    {
      title: 'One expense in full',
      description:
        'A single expense with who paid, each person’s share, and — for scanned or itemized receipts — ' +
        'every line item, tax, tip and discount with who owes what on each. Takes an id from list_expenses.',
      inputSchema: { expense_id: z.string().uuid() },
      annotations: READ,
    },
    (args) => guarded(() => getExpenseDetail(ctx, args)),
  );

  server.registerTool(
    'list_settlements',
    {
      title: 'Payments between housemates',
      description: 'Recorded payments that settle shared expenses, newest first.',
      inputSchema: {
        since: day.optional(),
        until: day.optional(),
        person: z.string().max(80).optional().describe('Payments sent or received by this person'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ,
    },
    (args) => guarded(() => listSettlements(ctx, args)),
  );

  server.registerTool(
    'list_recurring_expenses',
    {
      title: 'Recurring bills',
      description: 'Bills that post automatically (rent, internet…): amount, how often, next date, and the split.',
      inputSchema: { include_inactive: z.boolean().optional() },
      annotations: READ,
    },
    (args) => guarded(() => listRecurringExpenses(ctx, args)),
  );

  server.registerTool(
    'chore_history',
    {
      title: 'Chores that were done',
      description:
        'Completed chores, newest first, with who did each and on what date in the house’s timezone. ' +
        'Filter by date range, person, or chore. A covered_for field means someone took another’s turn.',
      inputSchema: {
        since: day.optional(),
        until: day.optional(),
        person: z.string().max(80).optional().describe('Name, initials, or "me"'),
        chore: z.string().max(80).optional().describe('Chore name such as "dishes"'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ,
    },
    (args) => guarded(() => choreHistory(ctx, args)),
  );

  server.registerTool(
    'chore_stats',
    {
      title: 'Chore tallies',
      description:
        'Turns done and missed per person, and per chore — the fairness check, e.g. who has done the ' +
        'least. All-time by default; pass since/until to count within a window such as "the last 30 ' +
        'days". Housemates with none still appear, with 0.',
      inputSchema: { since: day.optional(), until: day.optional() },
      annotations: READ,
    },
    (args) => guarded(() => choreStats(ctx, args)),
  );
}
