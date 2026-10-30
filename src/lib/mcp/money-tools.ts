import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { formatCents } from '@/lib/money';
import {
  WRITE, day, fail, guarded, members, money, nameOf, ok, resolveMany, scopeFor, type McpContext,
} from './common';
import { escapeLike, localDay, resolvePerson } from './ledger';
import {
  buildExpenseShares, buildReceiptItems, type PlainSplitKind, type ReceiptKind, type ReceiptLine, type Share,
} from './splits';

/**
 * Tools that put money in the ledger. They are the riskiest thing an assistant
 * can do here, so each one previews first: without `confirm: true` nothing is
 * written and the person is shown exactly what would be recorded. (That is a
 * convention the assistant is told to follow; the real backstop is the
 * assistant's own approval step for tools that change data, plus the rate
 * limit and the duplicate check below.) There is no edit or delete tool — fixing
 * a mistake is done in the app.
 */

const NEXT = (tool: string) =>
  `Show this to the person and ask them to confirm. If they approve, call ${tool} again with exactly ` +
  'the same arguments plus confirm: true.';

/** Cents are whole numbers, and nothing above a million dollars is a household expense. */
const cents = z.number().int().min(1).max(100_000_000);

const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

async function recentDuplicateExpense(
  ctx: McpContext,
  e: { household_id: string; description: string; amount_cents: number; paid_by: string; spent_on: string },
): Promise<string | null> {
  const { data } = await ctx.supabase
    .from('expenses')
    .select('id')
    .eq('household_id', e.household_id)
    .ilike('description', escapeLike(e.description.trim()))
    .eq('amount_cents', e.amount_cents)
    .eq('paid_by', e.paid_by)
    .eq('spent_on', e.spent_on)
    .is('deleted_at', null)
    .gte('created_at', new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString())
    .limit(1)
    .returns<{ id: string }[]>();
  return data?.[0]?.id ?? null;
}

/** One notification each, carrying that person's own share — "you owe $8.75" is what they care about. */
async function notifyShares(
  ctx: McpContext,
  e: { id: string; description: string; amount_cents: number; payer: string },
  owed: { profile_id: string; owed_cents: number }[],
) {
  await Promise.all(
    owed
      .filter((s) => s.profile_id !== ctx.userId && s.owed_cents > 0)
      .map((s) =>
        ctx.notify([s.profile_id], {
          title: `${e.description} — ${formatCents(e.amount_cents)}`,
          body: `${e.payer} paid. Your share is ${formatCents(s.owed_cents)}.`,
          url: '/expenses',
          tag: `expense-${e.id}`,
        }),
      ),
  );
}

type ExpenseCommon = {
  description: string;
  paid_by?: string;
  spent_on?: string;
  category?: string;
  note?: string;
  confirm?: boolean;
  allow_duplicate?: boolean;
};

/* -------------------------------------------------------------- plain expense */

export async function addExpense(
  ctx: McpContext,
  args: ExpenseCommon & {
    amount_cents: number;
    split_between?: string[];
    split_kind?: PlainSplitKind;
    values?: Record<string, number>;
  },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'expenses');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  const payer = resolvePerson(people, args.paid_by ?? 'me', ctx.userId);
  if ('error' in payer) return fail(payer.error);

  let participants = people.map((p) => p.id);
  if (args.split_between?.length) {
    const who = resolveMany(people, args.split_between, ctx.userId);
    if (!who.ok) return fail(who.error);
    participants = who.ids;
  }

  let values: Record<string, number> | undefined;
  if (args.values) {
    values = {};
    for (const [who, v] of Object.entries(args.values)) {
      const found = resolvePerson(people, who, ctx.userId);
      if ('error' in found) return fail(found.error);
      if (!participants.includes(found.id)) {
        return fail(`${name(found.id)} has an amount but is not in split_between.`);
      }
      values[found.id] = v;
    }
  }

  const kind = args.split_kind ?? 'equal';
  const built = buildExpenseShares(kind, args.amount_cents, participants, values);
  if (!built.ok) return fail(built.error);

  const spentOn = args.spent_on ?? localDay(new Date(), scope.household.timezone);
  const duplicateOf = await recentDuplicateExpense(ctx, {
    household_id: scope.household.id,
    description: args.description,
    amount_cents: args.amount_cents,
    paid_by: payer.id,
    spent_on: spentOn,
  });

  const summary = {
    description: args.description.trim(),
    ...money(args.amount_cents),
    paid_by: name(payer.id),
    spent_on: spentOn,
    category: args.category?.trim() || 'general',
    split_kind: kind,
    shares: built.shares.map((s) => ({ person: name(s.profile_id), ...money(s.owed_cents) })),
  };

  if (!args.confirm) {
    return ok({
      confirmed: false,
      nothing_recorded_yet: true,
      preview: summary,
      ...(duplicateOf ? { warning: 'An identical expense was added in the last few minutes.' } : {}),
      next: NEXT('add_expense'),
    });
  }
  if (duplicateOf && !args.allow_duplicate) {
    return fail(
      'An identical expense was added in the last few minutes, so this looks like a repeat. ' +
        'If it really is a second one, call again with allow_duplicate: true.',
    );
  }

  const { data: expense, error } = await ctx.supabase.rpc('create_expense', {
    p_description: args.description,
    p_amount_cents: args.amount_cents,
    p_paid_by: payer.id,
    p_spent_on: spentOn,
    p_split_kind: kind,
    p_shares: built.shares,
    p_category: args.category?.trim() || 'general',
    p_note: args.note ?? null,
  });
  if (error || !expense) return fail(error?.message ?? 'Could not save the expense.');

  await notifyShares(
    ctx,
    { id: expense.id, description: summary.description, amount_cents: args.amount_cents, payer: name(payer.id)! },
    built.shares,
  );

  return ok({ confirmed: true, recorded: true, expense_id: expense.id, ...summary });
}

/* ------------------------------------------------------------------ receipts */

export async function addItemizedExpense(
  ctx: McpContext,
  args: ExpenseCommon & {
    receipt_total_cents: number;
    lines: { name: string; amount_cents: number; kind?: ReceiptKind; assigned_to?: string[] }[];
  },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'expenses');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  const payer = resolvePerson(people, args.paid_by ?? 'me', ctx.userId);
  if ('error' in payer) return fail(payer.error);

  // The check that makes an assistant's reading of a photo trustworthy: if it
  // missed a line, misread a price, or got a sign wrong, the lines will not add
  // up to what is printed on the receipt, and nothing is recorded.
  const linesTotal = args.lines.reduce((sum, l) => sum + l.amount_cents, 0);
  if (linesTotal !== args.receipt_total_cents) {
    const diff = args.receipt_total_cents - linesTotal;
    return fail(
      `The lines add up to ${formatCents(linesTotal)} but the receipt total is ` +
        `${formatCents(args.receipt_total_cents)} — ${formatCents(Math.abs(diff))} ${diff > 0 ? 'short' : 'over'}. ` +
        'Look for a missed line, tax, tip or discount, or a misread price, then try again.',
    );
  }

  const lines: ReceiptLine[] = [];
  for (const l of args.lines) {
    let assigned: string[] | undefined;
    if (l.assigned_to?.length) {
      const who = resolveMany(people, l.assigned_to, ctx.userId);
      if (!who.ok) return fail(`On "${l.name}": ${who.error}`);
      assigned = who.ids;
    }
    lines.push({ name: l.name.trim(), amount_cents: l.amount_cents, kind: l.kind ?? 'item', assigned_to: assigned });
  }

  const built = buildReceiptItems(lines, people.map((p) => p.id));
  if (!built.ok) return fail(built.error);

  const spentOn = args.spent_on ?? localDay(new Date(), scope.household.timezone);
  const duplicateOf = await recentDuplicateExpense(ctx, {
    household_id: scope.household.id,
    description: args.description,
    amount_cents: built.total_cents,
    paid_by: payer.id,
    spent_on: spentOn,
  });

  const summary = {
    description: args.description.trim(),
    ...money(built.total_cents),
    paid_by: name(payer.id),
    spent_on: spentOn,
    category: args.category?.trim() || 'general',
    lines: built.items.map((item) => ({
      name: item.name,
      kind: item.kind,
      ...money(item.amount_cents),
      shared_by: item.splits.map((s) => name(s.profile_id)),
    })),
    each_person_owes: Object.entries(built.per_person).map(([id, c]) => ({ person: name(id), ...money(c) })),
  };

  if (!args.confirm) {
    return ok({
      confirmed: false,
      nothing_recorded_yet: true,
      preview: summary,
      ...(duplicateOf ? { warning: 'An identical expense was added in the last few minutes.' } : {}),
      next: NEXT('add_itemized_expense'),
    });
  }
  if (duplicateOf && !args.allow_duplicate) {
    return fail(
      'An identical expense was added in the last few minutes, so this looks like a repeat. ' +
        'If it really is a second one, call again with allow_duplicate: true.',
    );
  }

  const { data: expense, error } = await ctx.supabase.rpc('create_itemized_expense', {
    p_description: args.description,
    p_paid_by: payer.id,
    p_spent_on: spentOn,
    p_items: built.items.map((i) => ({
      name: i.name,
      amount_cents: i.amount_cents,
      kind: i.kind,
      split_kind: i.split_kind,
      position: i.position,
      splits: i.splits,
    })),
    p_category: args.category?.trim() || 'general',
    p_receipt_url: null,
    p_note: args.note ?? null,
  });
  if (error || !expense) return fail(error?.message ?? 'Could not save the receipt.');

  const owed: Share[] = Object.entries(built.per_person).map(([profile_id, owed_cents]) => ({
    profile_id, owed_cents, weight: null,
  }));
  await notifyShares(
    ctx,
    { id: expense.id, description: summary.description, amount_cents: built.total_cents, payer: name(payer.id)! },
    owed,
  );

  return ok({ confirmed: true, recorded: true, expense_id: expense.id, ...summary });
}

/* ------------------------------------------------------------------ payments */

export async function recordPayment(
  ctx: McpContext,
  args: {
    to: string; amount_cents: number; from?: string; paid_on?: string; method?: string;
    note?: string; confirm?: boolean; allow_duplicate?: boolean;
  },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'expenses');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  const from = resolvePerson(people, args.from ?? 'me', ctx.userId);
  if ('error' in from) return fail(from.error);
  const to = resolvePerson(people, args.to, ctx.userId);
  if ('error' in to) return fail(to.error);
  if (from.id === to.id) return fail('A payment needs two different people.');

  const paidOn = args.paid_on ?? localDay(new Date(), scope.household.timezone);
  const method = args.method?.trim() || 'venmo';

  const { data: dupes } = await ctx.supabase
    .from('settlements')
    .select('id')
    .eq('household_id', scope.household.id)
    .eq('from_profile', from.id)
    .eq('to_profile', to.id)
    .eq('amount_cents', args.amount_cents)
    .eq('settled_on', paidOn)
    .gte('created_at', new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString())
    .limit(1)
    .returns<{ id: string }[]>();
  const duplicate = (dupes ?? []).length > 0;

  const summary = {
    from: name(from.id),
    to: name(to.id),
    ...money(args.amount_cents),
    paid_on: paidOn,
    method,
    ...(args.note ? { note: args.note } : {}),
  };

  if (!args.confirm) {
    return ok({
      confirmed: false,
      nothing_recorded_yet: true,
      note: 'This only logs a payment that already happened; it does not move any money.',
      preview: summary,
      ...(duplicate ? { warning: 'An identical payment was logged in the last few minutes.' } : {}),
      next: NEXT('record_payment'),
    });
  }
  if (duplicate && !args.allow_duplicate) {
    return fail(
      'An identical payment was logged in the last few minutes, so this looks like a repeat. ' +
        'If it really is a second one, call again with allow_duplicate: true.',
    );
  }

  const { data: settlement, error } = await ctx.supabase
    .from('settlements')
    .insert({
      household_id: scope.household.id,
      from_profile: from.id,
      to_profile: to.id,
      amount_cents: args.amount_cents,
      settled_on: paidOn,
      method,
      note: args.note ?? null,
      created_by: ctx.userId,
    })
    .select('id')
    .single<{ id: string }>();
  if (error || !settlement) return fail(error?.message ?? 'Could not record the payment.');

  const amount = formatCents(args.amount_cents);
  if (to.id !== ctx.userId) {
    await ctx.notify([to.id], { title: 'You got paid', body: `${amount} settled up.`, url: '/expenses', tag: 'settlement' });
  }
  if (from.id !== ctx.userId) {
    await ctx.notify([from.id], {
      title: 'A payment was logged for you',
      body: `${scope.me.full_name} recorded that you paid ${amount}.`,
      url: '/expenses',
      tag: 'settlement',
    });
  }

  // A payment between this pair clears whatever nudges were asking for it.
  await ctx.supabase
    .from('settle_nudges')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('from_profile', from.id)
    .eq('to_profile', to.id)
    .is('dismissed_at', null);

  return ok({ confirmed: true, recorded: true, settlement_id: settlement.id, ...summary });
}

export async function requestSettleUp(
  ctx: McpContext,
  args: { from: string; amount_cents: number },
): Promise<CallToolResult> {
  const scope = await scopeFor(ctx, 'expenses');
  if ('error' in scope) return fail(scope.error);

  const people = await members(ctx, scope.household.id);
  const name = nameOf(people);

  const debtor = resolvePerson(people, args.from, ctx.userId);
  if ('error' in debtor) return fail(debtor.error);
  if (debtor.id === ctx.userId) return fail("You can't nudge yourself.");

  // One open nudge per pair is plenty; a second is just noise.
  const { data: open } = await ctx.supabase
    .from('settle_nudges')
    .select('id')
    .eq('from_profile', debtor.id)
    .eq('to_profile', ctx.userId)
    .is('dismissed_at', null)
    .limit(1)
    .returns<{ id: string }[]>();
  if ((open ?? []).length > 0) {
    return fail(`${name(debtor.id)} already has an open nudge from you. They can dismiss it, or paying you clears it.`);
  }

  const { error } = await ctx.supabase.from('settle_nudges').insert({
    household_id: scope.household.id,
    from_profile: debtor.id,
    to_profile: ctx.userId,
    amount_cents: args.amount_cents,
  });
  if (error) return fail(error.message);

  const amount = formatCents(args.amount_cents);
  const first = scope.me.full_name.split(' ')[0];
  await ctx.notify([debtor.id], {
    title: `${first} nudged you`,
    body: `You owe ${first} ${amount} — settle up when you get a chance.`,
    url: '/expenses',
    tag: `settle-nudge-${ctx.userId}-${debtor.id}`,
  });

  await ctx.supabase.from('activity_log').insert({
    household_id: scope.household.id,
    actor_id: ctx.userId,
    verb: 'requested_settlement',
    summary: `${scope.me.full_name} nudged ${name(debtor.id)} to settle up — ${amount}`,
    metadata: { from_profile: debtor.id, to_profile: ctx.userId, amount_cents: args.amount_cents },
  });

  return ok({ ok: true, nudged: name(debtor.id), ...money(args.amount_cents) });
}

/* ------------------------------------------------------------- registration */

const commonArgs = {
  description: z.string().min(1).max(120),
  paid_by: z.string().max(80).optional().describe('Who paid. Defaults to the signed-in person.'),
  spent_on: day.optional().describe('Defaults to today in the house’s timezone.'),
  category: z.string().max(40).optional(),
  note: z.string().max(500).optional(),
  confirm: z
    .boolean()
    .optional()
    .describe('Leave off to preview. Set true only after the person has seen the preview and agreed.'),
  allow_duplicate: z.boolean().optional().describe('Only if the person says it really is a second identical one.'),
};

export function registerMoneyTools(server: McpServer, ctx: McpContext) {
  server.registerTool(
    'add_expense',
    {
      title: 'Add a shared expense',
      description:
        'Records an expense one person paid for and splits it. Always preview first: call without confirm ' +
        'to see exactly what would be recorded, show the person, and only then call again with confirm: ' +
        'true. Amounts are whole cents ($47.30 is 4730). split_between lists who shares it (default ' +
        'everyone). split_kind is equal (default), exact (values are cents per person), shares (values are ' +
        'weights), or percent (values must add up to 100); values is keyed by person name. For a receipt ' +
        'with separate lines, use add_itemized_expense instead.',
      inputSchema: {
        ...commonArgs,
        amount_cents: cents,
        split_between: z.array(z.string().max(80)).max(20).optional(),
        split_kind: z.enum(['equal', 'exact', 'shares', 'percent']).optional(),
        values: z.record(z.string(), z.number()).optional(),
      },
      annotations: WRITE,
    },
    (args) => guarded(() => addExpense(ctx, args)),
  );

  server.registerTool(
    'add_itemized_expense',
    {
      title: 'Add a receipt, line by line',
      description:
        'Records a receipt with each line split on its own. Read the receipt image carefully and list EVERY ' +
        'line: each purchased item (kind "item"), then tax, tip, fees, and discounts (kind "discount", a ' +
        'NEGATIVE amount). Amounts are whole cents ($4.99 is 499). Set receipt_total_cents to the total ' +
        'PRINTED on the receipt: the lines must add up to it exactly or nothing is recorded, which catches ' +
        'a misread price or a missed line. Leave assigned_to off a line to split it among everyone; name ' +
        'people for personal items. Tax, tip and fees are shared in proportion to what each person’s own ' +
        'items came to, unless you assign them. Always preview first (call without confirm), show the ' +
        'person the per-line breakdown and what each person owes, and only then call again with confirm: true.',
      inputSchema: {
        ...commonArgs,
        receipt_total_cents: z.number().int().min(1).max(100_000_000)
          .describe('The grand total printed on the receipt, in cents'),
        lines: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              amount_cents: z.number().int().min(-100_000_000).max(100_000_000),
              kind: z.enum(['item', 'tax', 'tip', 'discount', 'fee']).optional(),
              assigned_to: z.array(z.string().max(80)).max(20).optional()
                .describe('Names of who shares this line; omit for the default'),
            }),
          )
          .min(1)
          .max(100),
      },
      annotations: WRITE,
    },
    (args) => guarded(() => addItemizedExpense(ctx, args)),
  );

  server.registerTool(
    'record_payment',
    {
      title: 'Log a payment between housemates',
      description:
        'Logs that someone already paid someone back (Venmo, cash…); it does not move any money. Preview ' +
        'first, then confirm: true. from defaults to the signed-in person. Amounts are whole cents.',
      inputSchema: {
        to: z.string().min(1).max(80),
        amount_cents: cents,
        from: z.string().max(80).optional(),
        paid_on: day.optional(),
        method: z.string().max(40).optional().describe('Defaults to venmo'),
        note: z.string().max(500).optional(),
        confirm: commonArgs.confirm,
        allow_duplicate: commonArgs.allow_duplicate,
      },
      annotations: WRITE,
    },
    (args) => guarded(() => recordPayment(ctx, args)),
  );

  server.registerTool(
    'request_settle_up',
    {
      title: 'Nudge someone to settle up',
      description:
        'Sends a housemate a “please settle up” nudge for an amount they owe the signed-in person. Check ' +
        'get_balances first so the amount is right. Amounts are whole cents.',
      inputSchema: { from: z.string().min(1).max(80).describe('Who owes'), amount_cents: cents },
      annotations: WRITE,
    },
    (args) => guarded(() => requestSettleUp(ctx, args)),
  );
}
