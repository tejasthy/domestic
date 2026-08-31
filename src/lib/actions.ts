'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { notifyProfiles } from '@/lib/push';
import { splitEqual, splitByWeight, parseDollars } from '@/lib/money';

export type ActionResult = { ok: true } | { ok: false; error: string };

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

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback`,
      // Everyone is invited by the seed script; nobody self-registers.
      shouldCreateUser: false,
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
        url: '/',
        tag: `chore-${turn.chore_id}`,
      });
    }
  }

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
      url: '/',
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

const ExpenseInput = z.object({
  description: z.string().min(1, 'Give it a name.').max(120),
  amount: z.string(),
  paid_by: z.string().uuid(),
  spent_on: z.string(),
  category: z.string().default('general'),
  split_kind: z.enum(['equal', 'exact', 'shares', 'percent']).default('equal'),
  /** profile ids included in the split */
  participants: z.array(z.string().uuid()).min(1, 'Split it with someone.'),
  /** for exact/shares/percent: profile id -> raw value */
  weights: z.record(z.string(), z.number()).optional(),
  note: z.string().max(500).optional(),
  receipt_url: z.string().url().optional(),
});

export type ExpenseInputType = z.input<typeof ExpenseInput>;

export async function addExpense(input: ExpenseInputType): Promise<ActionResult> {
  const parsed = ExpenseInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid expense.' };
  }
  const e = parsed.data;

  const amountCents = parseDollars(e.amount);
  if (!amountCents || amountCents <= 0) {
    return { ok: false, error: 'Enter an amount greater than zero.' };
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { data: me } = await supabase
    .from('profiles').select('household_id, full_name').eq('id', user.id)
    .single<{ household_id: string; full_name: string }>();
  if (!me?.household_id) return { ok: false, error: 'No household.' };

  // Work out each person's share before writing anything, so a bad split
  // never leaves a half-recorded expense behind.
  let owed: Record<string, number>;
  if (e.split_kind === 'equal') {
    owed = splitEqual(amountCents, e.participants);
  } else if (e.split_kind === 'exact') {
    owed = Object.fromEntries(
      e.participants.map((id) => [id, Math.round((e.weights?.[id] ?? 0) * 100)]),
    );
    const sum = Object.values(owed).reduce((a, b) => a + b, 0);
    if (sum !== amountCents) {
      const diff = (amountCents - sum) / 100;
      return {
        ok: false,
        error: `Exact splits must add up to the total — you're ${diff > 0 ? 'short' : 'over'} by $${Math.abs(diff).toFixed(2)}.`,
      };
    }
  } else {
    const weights = Object.fromEntries(
      e.participants.map((id) => [id, e.weights?.[id] ?? 0]),
    );
    if (Object.values(weights).every((w) => w <= 0)) {
      return { ok: false, error: 'Give at least one person a share.' };
    }
    owed = splitByWeight(amountCents, weights);
  }

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

  const { error: splitErr } = await supabase.from('expense_splits').insert(
    e.participants.map((id) => ({
      expense_id: expense.id,
      profile_id: id,
      owed_cents: owed[id] ?? 0,
      weight: e.weights?.[id] ?? null,
    })),
  );

  if (splitErr) {
    // Roll back rather than leave an expense with no splits, which would
    // silently skew every balance in the house.
    await supabase.from('expenses').delete().eq('id', expense.id);
    return { ok: false, error: splitErr.message };
  }

  await supabase.from('activity_log').insert({
    household_id: me.household_id,
    actor_id: user.id,
    verb: 'added_expense',
    summary: `${me.full_name} added ${e.description} — $${(amountCents / 100).toFixed(2)}`,
    metadata: { expense_id: expense.id, amount_cents: amountCents },
  });

  // One notification each, carrying that person's own share rather than the
  // total — "you owe $8.75" is the number they actually care about.
  await Promise.all(
    e.participants
      .filter((id) => id !== user.id)
      .map((id) =>
        notifyProfiles([id], {
          title: `${e.description} — $${(amountCents / 100).toFixed(2)}`,
          body: `${me.full_name} paid. Your share is $${((owed[id] ?? 0) / 100).toFixed(2)}.`,
          url: '/expenses',
          tag: `expense-${expense.id}`,
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

export async function recordSettlement(
  fromProfile: string,
  toProfile: string,
  amountDollars: string,
  method = 'venmo',
): Promise<ActionResult> {
  const cents = parseDollars(amountDollars);
  if (!cents || cents <= 0) return { ok: false, error: 'Enter an amount.' };
  if (fromProfile === toProfile) return { ok: false, error: 'Pick two different people.' };

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { data: me } = await supabase
    .from('profiles').select('household_id').eq('id', user.id)
    .single<{ household_id: string }>();
  if (!me?.household_id) return { ok: false, error: 'No household.' };

  const { error } = await supabase.from('settlements').insert({
    household_id: me.household_id,
    from_profile: fromProfile,
    to_profile: toProfile,
    amount_cents: cents,
    method,
    created_by: user.id,
  });
  if (error) return { ok: false, error: error.message };

  await notifyProfiles([toProfile], {
    title: 'You got paid',
    body: `$${(cents / 100).toFixed(2)} settled up.`,
    url: '/expenses',
    tag: 'settlement',
  });

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
