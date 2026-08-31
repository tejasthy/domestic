'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import type { ActionResult } from '@/lib/actions';
import type { ChoreCadence } from '@/lib/types';

/** Postgres exceptions arrive with a `message` that is already user-facing. */
function fail(error: { message: string } | null, fallback: string): ActionResult {
  return { ok: false, error: error?.message ?? fallback };
}

const ChoreInput = z.object({
  name: z.string().min(1, 'Give it a name.').max(80),
  emoji: z.string().min(1).max(8).default('🧹'),
  description: z.string().max(300).optional(),
  cadence: z.enum(['scheduled', 'on_demand']),
  days_of_week: z.array(z.number().int().min(0).max(6)).default([]),
  interval_weeks: z.number().int().min(1).max(52).default(1),
  due_hour: z.number().int().min(0).max(23).default(20),
  queue_depth: z.number().int().min(1).max(20).default(4),
  lookahead_days: z.number().int().min(1).max(90).default(21),
  profile_ids: z.array(z.string().uuid()).default([]),
});

export type ChoreInputType = z.input<typeof ChoreInput>;

export async function createChore(
  input: ChoreInputType,
): Promise<ActionResult & { choreId?: string }> {
  const parsed = ChoreInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const c = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('create_chore', {
    p_name: c.name,
    p_cadence: c.cadence,
    p_emoji: c.emoji,
    p_description: c.description || null,
    p_days_of_week: c.days_of_week,
    p_interval_weeks: c.interval_weeks,
    p_due_hour: c.due_hour,
    p_queue_depth: c.queue_depth,
    p_lookahead_days: c.lookahead_days,
    p_profile_ids: c.profile_ids,
  });

  if (error) return fail(error, 'Could not add that chore.');
  revalidatePath('/', 'layout');
  return { ok: true, choreId: (data as { id: string } | null)?.id };
}

export async function updateChore(
  choreId: string,
  input: ChoreInputType,
): Promise<ActionResult> {
  const parsed = ChoreInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }
  const c = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.rpc('update_chore', {
    p_chore: choreId,
    p_name: c.name,
    p_emoji: c.emoji,
    p_description: c.description || '',
    p_cadence: c.cadence as ChoreCadence,
    p_days_of_week: c.days_of_week,
    p_interval_weeks: c.interval_weeks,
    p_due_hour: c.due_hour,
    p_queue_depth: c.queue_depth,
    p_lookahead_days: c.lookahead_days,
  });
  if (error) return fail(error, 'Could not save that chore.');

  const { error: rotError } = await supabase.rpc('set_chore_rotation', {
    p_chore: choreId,
    p_profile_ids: c.profile_ids,
  });
  if (rotError) return fail(rotError, 'Could not save the rotation.');

  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function setChoreActive(choreId: string, active: boolean): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_chore_active', { p_chore: choreId, p_active: active });
  if (error) return fail(error, 'Could not change that chore.');
  revalidatePath('/', 'layout');
  return { ok: true };
}
