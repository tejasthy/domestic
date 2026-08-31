'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import type { ActionResult } from '@/lib/actions';
import { parseDollars, splitEqual, splitByWeight } from '@/lib/money';
import type { RecurringCadence, SplitKind } from '@/lib/types';

/** Postgres exceptions arrive with a `message` that is already user-facing. */
function fail(error: { message: string } | null, fallback: string): ActionResult {
  return { ok: false, error: error?.message ?? fallback };
}

const RecurringExpenseInput = z.object({
  description: z.string().min(1, 'Give it a name.').max(120),
  amount: z.string(),
  paid_by: z.string().uuid(),
  category: z.string().default('general'),
  split_kind: z.enum(['equal', 'exact', 'shares', 'percent']).default('equal'),
  participants: z.array(z.string().uuid()).min(1, 'Split it with someone.'),
  /** for exact/shares/percent: profile id -> raw value */
  weights: z.record(z.string(), z.number()).optional(),
  cadence: z.enum(['weekly', 'monthly']),
  interval_weeks: z.number().int().min(1).max(8).default(1),
  interval_months: z.number().int().min(1).max(12).default(1),
  day_of_month: z.number().int().min(1).max(31).optional(),
  start_on: z.string().optional(),
});

export type RecurringExpenseInputType = z.input<typeof RecurringExpenseInput>;

/** Same split-resolution the one-off expense form uses — computed once here,
 * stored per participant, and simply replayed by post_due_recurring_expenses
 * on every occurrence rather than re-derived in plpgsql. */
function resolveSplit(
  splitKind: SplitKind,
  amountCents: number,
  participants: string[],
  weights: Record<string, number> | undefined,
): { owed: Record<string, number>; error?: string } {
  if (splitKind === 'equal') {
    return { owed: splitEqual(amountCents, participants) };
  }
  if (splitKind === 'exact') {
    const owed = Object.fromEntries(
      participants.map((id) => [id, Math.round((weights?.[id] ?? 0) * 100)]),
    );
    const sum = Object.values(owed).reduce((a, b) => a + b, 0);
    if (sum !== amountCents) {
      const diff = (amountCents - sum) / 100;
      return {
        owed,
        error: `Exact splits must add up to the total — you're ${diff > 0 ? 'short' : 'over'} by $${Math.abs(diff).toFixed(2)}.`,
      };
    }
    return { owed };
  }
  const w = Object.fromEntries(participants.map((id) => [id, weights?.[id] ?? 0]));
  if (Object.values(w).every((x) => x <= 0)) {
    return { owed: {}, error: 'Give at least one person a share.' };
  }
  return { owed: splitByWeight(amountCents, w) };
}

export async function createRecurringExpense(
  input: RecurringExpenseInputType,
): Promise<ActionResult & { id?: string }> {
  const parsed = RecurringExpenseInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const e = parsed.data;

  const amountCents = parseDollars(e.amount);
  if (!amountCents || amountCents <= 0) {
    return { ok: false, error: 'Enter an amount greater than zero.' };
  }
  if (e.cadence === 'monthly' && !e.day_of_month) {
    return { ok: false, error: 'Pick a day of the month.' };
  }

  const { owed, error: splitError } = resolveSplit(e.split_kind, amountCents, e.participants, e.weights);
  if (splitError) return { ok: false, error: splitError };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('create_recurring_expense', {
    p_description: e.description,
    p_amount_cents: amountCents,
    p_paid_by: e.paid_by,
    p_split_kind: e.split_kind,
    p_cadence: e.cadence as RecurringCadence,
    p_participants: e.participants.map((id) => ({
      profile_id: id,
      owed_cents: owed[id] ?? 0,
      weight: e.weights?.[id] ?? null,
    })),
    p_category: e.category,
    p_interval_weeks: e.interval_weeks,
    p_interval_months: e.interval_months,
    p_day_of_month: e.day_of_month ?? null,
    p_start_on: e.start_on || undefined,
  });

  if (error) return fail(error, 'Could not save that.');
  revalidatePath('/', 'layout');
  return { ok: true, id: (data as { id: string } | null)?.id };
}

export async function updateRecurringExpense(
  id: string,
  input: RecurringExpenseInputType,
): Promise<ActionResult> {
  const parsed = RecurringExpenseInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const e = parsed.data;

  const amountCents = parseDollars(e.amount);
  if (!amountCents || amountCents <= 0) {
    return { ok: false, error: 'Enter an amount greater than zero.' };
  }
  if (e.cadence === 'monthly' && !e.day_of_month) {
    return { ok: false, error: 'Pick a day of the month.' };
  }

  const { owed, error: splitError } = resolveSplit(e.split_kind, amountCents, e.participants, e.weights);
  if (splitError) return { ok: false, error: splitError };

  const supabase = await createClient();
  const { error } = await supabase.rpc('update_recurring_expense', {
    p_id: id,
    p_description: e.description,
    p_amount_cents: amountCents,
    p_paid_by: e.paid_by,
    p_split_kind: e.split_kind,
    p_category: e.category,
    p_cadence: e.cadence as RecurringCadence,
    p_interval_weeks: e.interval_weeks,
    p_interval_months: e.interval_months,
    p_day_of_month: e.day_of_month ?? null,
    p_participants: e.participants.map((pid) => ({
      profile_id: pid,
      owed_cents: owed[pid] ?? 0,
      weight: e.weights?.[pid] ?? null,
    })),
  });

  if (error) return fail(error, 'Could not save that.');
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function setRecurringExpenseActive(id: string, active: boolean): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_recurring_expense_active', { p_id: id, p_active: active });
  if (error) return fail(error, 'Could not change that.');
  revalidatePath('/', 'layout');
  return { ok: true };
}
