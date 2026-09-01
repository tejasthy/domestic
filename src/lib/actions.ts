'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { notifyProfiles } from '@/lib/push';
import { splitEqual, splitByWeight, splitByAdjustment, parseDollars } from '@/lib/money';
import { THEME_COOKIE, type ThemeMode } from '@/lib/theme';

export type ActionResult = { ok: true } | { ok: false; error: string };

/* ------------------------------------------------------------------ theme */

/**
 * Per-device, not per-account: a household shares logins across a phone, a
 * laptop, and an unauthenticated kiosk tablet, so this rides a plain cookie
 * rather than `profiles` — no session required, and each screen keeps its
 * own preference.
 */
export async function setTheme(theme: ThemeMode): Promise<ActionResult> {
  const store = await cookies();
  if (theme === 'system') store.delete(THEME_COOKIE);
  else store.set(THEME_COOKIE, theme, { maxAge: 60 * 60 * 24 * 365, path: '/', sameSite: 'lax' });
  revalidatePath('/', 'layout');
  return { ok: true };
}

/* ------------------------------------------------------------------- auth */

export async function sendMagicLink(_prev: unknown, formData: FormData): Promise<ActionResult> {
  // Hiding the form is not access control; refuse here too.
  if (process.env.NEXT_PUBLIC_ENABLE_MAGIC_LINK !== 'true') {
    return {
      ok: false,
      error: 'Email sign-in is off for this house. Use Continue with Google.',
    };
  }

  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!z.string().email().safeParse(email).success) {
    return { ok: false, error: 'That does not look like an email address.' };
  }
  const captchaToken = String(formData.get('captchaToken') ?? '') || undefined;
  const next = String(formData.get('next') ?? '/home');

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=${encodeURIComponent(next)}`,
      // Anyone can sign up; household membership is still gated separately —
      // by an invite code (redeem_invite) or by starting a new house.
      shouldCreateUser: true,
      captchaToken,
    },
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

/* ------------------------------------------------------------------ chores */

export async function completeTurn(turnId: string, note?: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: turn } = await supabase
    .from('chore_turns')
    .select('id, chore_id, assignee_id, household_id, chore:chores(name, emoji)')
    .eq('id', turnId)
    .single<{ id: string; chore_id: string; assignee_id: string; household_id: string; chore: { name: string; emoji: string } }>();

  const { error } = await supabase.rpc('complete_turn', {
    p_turn: turnId,
    p_note: note ?? null,
  });
  if (error) return { ok: false, error: error.message };

  // Tell whoever is up next that the baton moved.
  if (turn) {
    const { data: next } = await supabase
      .from('chore_turns')
      .select('assignee_id')
      .eq('chore_id', turn.chore_id)
      .eq('status', 'pending')
      .order('turn_number')
      .limit(1)
      .single<{ assignee_id: string }>();

    if (next && next.assignee_id !== turn.assignee_id) {
      await notifyProfiles([next.assignee_id], {
        title: `${turn.chore.emoji} You're up: ${turn.chore.name}`,
        body: 'The rotation just moved to you.',
        url: '/home',
        tag: `chore-${turn.chore_id}`,
      });
    }
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Marks the current turn skipped (out of town, etc.) and moves the baton on. */
export async function skipTurn(turnId: string, note?: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: turn } = await supabase
    .from('chore_turns')
    .select('id, chore_id, assignee_id, household_id, chore:chores(name, emoji)')
    .eq('id', turnId)
    .single<{ id: string; chore_id: string; assignee_id: string; household_id: string; chore: { name: string; emoji: string } }>();

  const { error } = await supabase.rpc('skip_turn', {
    p_turn: turnId,
    p_note: note ?? null,
  });
  if (error) return { ok: false, error: error.message };

  if (turn) {
    const { data: next } = await supabase
      .from('chore_turns')
      .select('assignee_id')
      .eq('chore_id', turn.chore_id)
      .eq('status', 'pending')
      .order('turn_number')
      .limit(1)
      .single<{ assignee_id: string }>();

    if (next && next.assignee_id !== turn.assignee_id) {
      await notifyProfiles([next.assignee_id], {
        title: `${turn.chore.emoji} You're up: ${turn.chore.name}`,
        body: 'The rotation just moved to you.',
        url: '/home',
        tag: `chore-${turn.chore_id}`,
      });
    }
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Hands the turn to the next person in the rotation — same day, same turn
 * number — instead of cancelling the occurrence outright. */
export async function passTurn(turnId: string, note?: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: turn } = await supabase
    .from('chore_turns')
    .select('id, chore_id, assignee_id, household_id, chore:chores(name, emoji)')
    .eq('id', turnId)
    .single<{ id: string; chore_id: string; assignee_id: string; household_id: string; chore: { name: string; emoji: string } }>();

  const { error } = await supabase.rpc('pass_turn', {
    p_turn: turnId,
    p_note: note ?? null,
  });
  if (error) return { ok: false, error: error.message };

  if (turn) {
    const { data: next } = await supabase
      .from('chore_turns')
      .select('assignee_id')
      .eq('id', turnId)
      .single<{ assignee_id: string }>();

    if (next && next.assignee_id !== turn.assignee_id) {
      await notifyProfiles([next.assignee_id], {
        title: `${turn.chore.emoji} You're up: ${turn.chore.name}`,
        body: `${turn.chore.name} was passed to you.`,
        url: '/home',
        tag: `chore-${turn.chore_id}`,
      });
    }
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Reopens a turn that was marked done or skipped by mistake. */
export async function undoTurn(turnId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('undo_turn', { p_turn: turnId });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** "The dishwasher is full" / "the trash needs to go out." */
export async function flagChore(choreId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .rpc('flag_on_demand', { p_chore: choreId })
    .single<{ id: string; assignee_id: string }>();
  if (error) return { ok: false, error: error.message };

  const { data: chore } = await supabase
    .from('chores')
    .select('name, emoji')
    .eq('id', choreId)
    .single<{ name: string; emoji: string }>();

  if (data?.assignee_id && chore) {
    await notifyProfiles([data.assignee_id], {
      title: `${chore.emoji} ${chore.name} — you're up`,
      body: 'Someone flagged it as ready.',
      url: '/home',
      tag: `chore-${choreId}`,
    });
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function requestSwap(
  turnId: string,
  toProfileId: string,
  message?: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { error } = await supabase.from('chore_swaps').insert({
    turn_id: turnId,
    requested_by: user.id,
    requested_to: toProfileId,
    message: message ?? null,
  });
  if (error) return { ok: false, error: error.message };

  const { data: me } = await supabase
    .from('profiles').select('full_name').eq('id', user.id)
    .single<{ full_name: string }>();

  await notifyProfiles([toProfileId], {
    title: 'Chore swap request',
    body: `${me?.full_name ?? 'A roommate'} wants to swap a turn with you.`,
    url: '/chores',
    tag: `swap-${turnId}`,
  });

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** A short note that shows up on the wall display for a couple of days. */
export async function postKioskMessage(body: string): Promise<ActionResult> {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, error: 'Say something first.' };
  if (trimmed.length > 280) return { ok: false, error: 'Keep it under 280 characters.' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { data: me } = await supabase
    .from('profiles').select('household_id').eq('id', user.id)
    .single<{ household_id: string }>();
  if (!me?.household_id) return { ok: false, error: 'No household.' };

  const { error } = await supabase.from('kiosk_messages').insert({
    household_id: me.household_id,
    author_id: user.id,
    body: trimmed,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Clears a note before it naturally expires. RLS lets any housemate do this
 * — it's a shared board, not a private post. */
export async function deleteKioskMessage(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from('kiosk_messages').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/', 'layout');
  revalidatePath('/kiosk');
  return { ok: true };
}

export async function respondToSwap(swapId: string, accept: boolean): Promise<ActionResult> {
  const supabase = await createClient();

  if (accept) {
    const { error } = await supabase.rpc('accept_swap', { p_swap: swapId });
    if (error) return { ok: false, error: error.message };
  } else {
    const { error } = await supabase
      .from('chore_swaps')
      .update({ status: 'declined', resolved_at: new Date().toISOString() })
      .eq('id', swapId);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath('/', 'layout');
  return { ok: true };
}

/* ---------------------------------------------------------------- expenses */

const ExpenseItemSplitInput = z.object({
  profile_id: z.string().uuid(),
  owed_cents: z.number().int(),
  weight: z.number().nullable().default(null),
});

const ExpenseItemInput = z.object({
  name: z.string().min(1).max(120),
  amount_cents: z.number().int(),
  kind: z.enum(['item', 'tax', 'tip', 'discount', 'fee']).default('item'),
  split_kind: z.enum(['equal', 'exact', 'shares', 'percent', 'adjustment']).default('equal'),
  splits: z.array(ExpenseItemSplitInput).min(1, 'Assign this to someone.'),
});

const ExpenseInput = z.object({
  description: z.string().min(1, 'Give it a name.').max(120),
  amount: z.string().optional(),
  paid_by: z.string().uuid(),
  spent_on: z.string(),
  category: z.string().default('general'),
  split_kind: z.enum(['equal', 'exact', 'shares', 'percent', 'adjustment']).default('equal'),
  /** profile ids included in the split — required unless `items` is given */
  participants: z.array(z.string().uuid()).optional(),
  /** for exact/shares/percent/adjustment: profile id -> raw value */
  weights: z.record(z.string(), z.number()).optional(),
  /** itemized receipt: line items (+ tax/tip/discount rows), each with its own assignees and split method */
  items: z.array(ExpenseItemInput).optional(),
  note: z.string().max(500).optional(),
  receipt_url: z.string().url().optional(),
});

export type ExpenseInputType = z.input<typeof ExpenseInput>;

type SplitResult = { ok: true; owed: Record<string, number> } | { ok: false; error: string };

/** Shared by addExpense and updateExpense — the split math itself (money.ts)
 * must stay remainder-safe; this just picks the right function per split_kind
 * and turns its failure modes into the same friendly errors both callers show. */
function computeSplits(
  splitKind: 'equal' | 'exact' | 'shares' | 'percent' | 'adjustment',
  amountCents: number,
  participants: string[],
  weights: Record<string, number> | undefined,
): SplitResult {
  if (splitKind === 'equal') {
    return { ok: true, owed: splitEqual(amountCents, participants) };
  }
  if (splitKind === 'exact') {
    const owed = Object.fromEntries(
      participants.map((id) => [id, Math.round((weights?.[id] ?? 0) * 100)]),
    );
    const sum = Object.values(owed).reduce((a, b) => a + b, 0);
    if (sum !== amountCents) {
      const diff = (amountCents - sum) / 100;
      return {
        ok: false,
        error: `Exact splits must add up to the total — you're ${diff > 0 ? 'short' : 'over'} by $${Math.abs(diff).toFixed(2)}.`,
      };
    }
    return { ok: true, owed };
  }
  if (splitKind === 'adjustment') {
    const adjustments = Object.fromEntries(
      participants.map((id) => [id, Math.round((weights?.[id] ?? 0) * 100)]),
    );
    const sumAdj = Object.values(adjustments).reduce((a, b) => a + b, 0);
    if (sumAdj > amountCents) {
      return {
        ok: false,
        error: `Adjustments can't exceed the total — you're over by $${((sumAdj - amountCents) / 100).toFixed(2)}.`,
      };
    }
    const owed = splitByAdjustment(amountCents, participants, adjustments);
    if (Object.values(owed).some((c) => c < 0)) {
      return { ok: false, error: 'Someone would owe a negative amount — lower their adjustment.' };
    }
    return { ok: true, owed };
  }
  const w = Object.fromEntries(participants.map((id) => [id, weights?.[id] ?? 0]));
  if (Object.values(w).every((x) => x <= 0)) {
    return { ok: false, error: 'Give at least one person a share.' };
  }
  return { ok: true, owed: splitByWeight(amountCents, w) };
}

export async function addExpense(input: ExpenseInputType): Promise<ActionResult> {
  const parsed = ExpenseInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid expense.' };
  }
  const e = parsed.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { data: me } = await supabase
    .from('profiles').select('household_id, full_name').eq('id', user.id)
    .single<{ household_id: string; full_name: string }>();
  if (!me?.household_id) return { ok: false, error: 'No household.' };

  let expenseId: string;
  let amountCents: number;
  let owed: Record<string, number>;

  if (e.items && e.items.length > 0) {
    // Same invariant create_itemized_expense enforces server-side — checked
    // here too so a bad item comes back as a normal form error instead of a
    // raw Postgres one.
    for (const item of e.items) {
      const sum = item.splits.reduce((a, s) => a + s.owed_cents, 0);
      if (sum !== item.amount_cents) {
        return { ok: false, error: `"${item.name}"'s splits must add up to its amount.` };
      }
    }

    const { data: expense, error } = await supabase.rpc('create_itemized_expense', {
      p_description: e.description,
      p_paid_by: e.paid_by,
      p_spent_on: e.spent_on,
      p_items: e.items,
      p_category: e.category,
      p_receipt_url: e.receipt_url ?? null,
      p_note: e.note ?? null,
    });
    if (error || !expense) return { ok: false, error: error?.message ?? 'Could not save.' };

    expenseId = expense.id;
    amountCents = expense.amount_cents;

    const { data: splits } = await supabase
      .from('expense_splits')
      .select('profile_id, owed_cents')
      .eq('expense_id', expenseId);
    owed = Object.fromEntries((splits ?? []).map((s) => [s.profile_id, s.owed_cents]));
  } else {
    amountCents = parseDollars(e.amount ?? '') ?? 0;
    if (amountCents <= 0) return { ok: false, error: 'Enter an amount greater than zero.' };

    const participants = e.participants ?? [];
    if (participants.length === 0) return { ok: false, error: 'Split it with someone.' };

    // Work out each person's share before writing anything, so a bad split
    // never leaves a half-recorded expense behind.
    const result = computeSplits(e.split_kind, amountCents, participants, e.weights);
    if (!result.ok) return result;
    owed = result.owed;

    const { data: expense, error } = await supabase
      .from('expenses')
      .insert({
        household_id: me.household_id,
        description: e.description,
        amount_cents: amountCents,
        category: e.category,
        paid_by: e.paid_by,
        spent_on: e.spent_on,
        split_kind: e.split_kind,
        note: e.note ?? null,
        receipt_url: e.receipt_url ?? null,
        created_by: user.id,
      })
      .select('id')
      .single<{ id: string }>();

    if (error || !expense) return { ok: false, error: error?.message ?? 'Could not save.' };
    expenseId = expense.id;

    const { error: splitErr } = await supabase.from('expense_splits').insert(
      participants.map((id) => ({
        expense_id: expenseId,
        profile_id: id,
        owed_cents: owed[id] ?? 0,
        weight: e.weights?.[id] ?? null,
      })),
    );

    if (splitErr) {
      // Roll back rather than leave an expense with no splits, which would
      // silently skew every balance in the house.
      await supabase.from('expenses').delete().eq('id', expenseId);
      return { ok: false, error: splitErr.message };
    }

    await supabase.from('activity_log').insert({
      household_id: me.household_id,
      actor_id: user.id,
      verb: 'added_expense',
      summary: `${me.full_name} added ${e.description} — $${(amountCents / 100).toFixed(2)}`,
      metadata: { expense_id: expenseId, amount_cents: amountCents },
    });
  }

  // One notification each, carrying that person's own share rather than the
  // total — "you owe $8.75" is the number they actually care about.
  await Promise.all(
    Object.keys(owed)
      .filter((id) => id !== user.id)
      .map((id) =>
        notifyProfiles([id], {
          title: `${e.description} — $${(amountCents / 100).toFixed(2)}`,
          body: `${me.full_name} paid. Your share is $${((owed[id] ?? 0) / 100).toFixed(2)}.`,
          url: '/expenses',
          tag: `expense-${expenseId}`,
        }),
      ),
  );

  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function updateExpense(expenseId: string, input: ExpenseInputType): Promise<ActionResult> {
  const parsed = ExpenseInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid expense.' };
  }
  const e = parsed.data;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { data: me } = await supabase
    .from('profiles').select('household_id, full_name').eq('id', user.id)
    .single<{ household_id: string; full_name: string }>();
  if (!me?.household_id) return { ok: false, error: 'No household.' };

  let owed: Record<string, number>;
  let amountCents: number;

  if (e.items && e.items.length > 0) {
    for (const item of e.items) {
      const sum = item.splits.reduce((a, s) => a + s.owed_cents, 0);
      if (sum !== item.amount_cents) {
        return { ok: false, error: `"${item.name}"'s splits must add up to its amount.` };
      }
    }

    const { data: expense, error } = await supabase.rpc('update_expense', {
      p_expense_id: expenseId,
      p_description: e.description,
      p_paid_by: e.paid_by,
      p_spent_on: e.spent_on,
      p_items: e.items,
      p_category: e.category,
      p_receipt_url: e.receipt_url ?? null,
      p_note: e.note ?? null,
    });
    if (error || !expense) return { ok: false, error: error?.message ?? 'Could not save.' };
    amountCents = expense.amount_cents;

    const { data: splits } = await supabase
      .from('expense_splits')
      .select('profile_id, owed_cents')
      .eq('expense_id', expenseId);
    owed = Object.fromEntries((splits ?? []).map((s) => [s.profile_id, s.owed_cents]));
  } else {
    amountCents = parseDollars(e.amount ?? '') ?? 0;
    if (amountCents <= 0) return { ok: false, error: 'Enter an amount greater than zero.' };

    const participants = e.participants ?? [];
    if (participants.length === 0) return { ok: false, error: 'Split it with someone.' };

    const result = computeSplits(e.split_kind, amountCents, participants, e.weights);
    if (!result.ok) return result;
    owed = result.owed;

    const { data: expense, error } = await supabase.rpc('update_expense', {
      p_expense_id: expenseId,
      p_description: e.description,
      p_paid_by: e.paid_by,
      p_spent_on: e.spent_on,
      p_category: e.category,
      p_receipt_url: e.receipt_url ?? null,
      p_note: e.note ?? null,
      p_split_kind: e.split_kind,
      p_splits: participants.map((id) => ({
        profile_id: id,
        owed_cents: owed[id] ?? 0,
        weight: e.weights?.[id] ?? null,
      })),
    });
    if (error || !expense) return { ok: false, error: error?.message ?? 'Could not save.' };
  }

  await Promise.all(
    Object.keys(owed)
      .filter((id) => id !== user.id)
      .map((id) =>
        notifyProfiles([id], {
          title: `Updated: ${e.description} — $${(amountCents / 100).toFixed(2)}`,
          body: `${me.full_name} edited this. Your share is now $${((owed[id] ?? 0) / 100).toFixed(2)}.`,
          url: '/expenses',
          tag: `expense-${expenseId}`,
        }),
      ),
  );

  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function deleteExpense(expenseId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('expenses')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', expenseId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/', 'layout');
  return { ok: true };
}

const PaymentInput = z.object({
  from_profile: z.string().uuid(),
  to_profile: z.string().uuid(),
  amount: z.string(),
  paid_on: z.string(),
  method: z.string().min(1).max(40).default('venmo'),
  note: z.string().max(500).optional(),
});

export type PaymentInputType = z.input<typeof PaymentInput>;

/** Records a payment that already happened (Venmo, cash, etc.) — it does not
 * move any money. `created_by` may differ from both parties: anyone in the
 * household can log a payment on someone else's behalf. */
export async function recordPayment(
  input: PaymentInputType,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = PaymentInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const { from_profile, to_profile, amount, paid_on, method, note } = parsed.data;

  if (from_profile === to_profile) return { ok: false, error: 'Pick two different people.' };
  const cents = parseDollars(amount);
  if (!cents || cents <= 0) return { ok: false, error: 'Enter an amount.' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { data: me } = await supabase
    .from('profiles').select('household_id, full_name').eq('id', user.id)
    .single<{ household_id: string; full_name: string }>();
  if (!me?.household_id) return { ok: false, error: 'No household.' };

  const { data: settlement, error } = await supabase
    .from('settlements')
    .insert({
      household_id: me.household_id,
      from_profile,
      to_profile,
      amount_cents: cents,
      settled_on: paid_on,
      method,
      note: note ?? null,
      created_by: user.id,
    })
    .select('id')
    .single<{ id: string }>();
  if (error || !settlement) return { ok: false, error: error?.message ?? 'Could not record payment.' };

  if (to_profile !== user.id) {
    await notifyProfiles([to_profile], {
      title: 'You got paid',
      body: `$${(cents / 100).toFixed(2)} settled up.`,
      url: '/expenses',
      tag: 'settlement',
    });
  }
  if (from_profile !== user.id) {
    await notifyProfiles([from_profile], {
      title: 'A payment was logged for you',
      body: `${me.full_name} recorded that you paid $${(cents / 100).toFixed(2)}.`,
      url: '/expenses',
      tag: 'settlement',
    });
  }

  revalidatePath('/', 'layout');
  return { ok: true, id: settlement.id };
}

/** Undoes a recorded payment. Settlements have no soft-delete: the row is a
 * plain ledger fact, so undoing it removes it outright. */
export async function deleteSettlement(settlementId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from('settlements').delete().eq('id', settlementId);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/', 'layout');
  return { ok: true };
}

/* ------------------------------------------------------------- preferences */

export async function savePushSubscription(sub: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      profile_id: user.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      user_agent: sub.userAgent ?? null,
      last_used_at: new Date().toISOString(),
    },
    { onConflict: 'endpoint' },
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** One-way: seeing the walkthrough is not something you un-see. */
export async function markIntroSeen(): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { error } = await supabase
    .from('profiles')
    .update({ intro_seen_at: new Date().toISOString() })
    .eq('id', user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Marks the caller away (optionally until a return date) and pulls them out
 * of every active chore's rotation — resync/top-up happen inside the RPC. */
export async function setAway(until?: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_away', { p_until: until ?? null });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings');
  revalidatePath('/', 'layout');
  return { ok: true };
}

/** Ends the caller's away period early and puts them back in rotation. */
export async function clearAway(): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('clear_away');
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings');
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function updatePreferences(input: {
  notify_push?: boolean;
  quiet_from?: number;
  quiet_to?: number;
  color?: string;
}): Promise<ActionResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { error } = await supabase.from('profiles').update(input).eq('id', user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings');
  return { ok: true };
}
