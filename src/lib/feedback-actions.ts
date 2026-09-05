'use server';

import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import type { ActionResult } from '@/lib/actions';

const Feedback = z.object({
  kind: z.enum(['bug', 'feature']),
  body: z.string().min(1, 'Say a little about what happened.').max(4000),
  path: z.string().max(200).optional(),
});

export type FeedbackInput = z.input<typeof Feedback>;

export async function submitFeedback(
  input: FeedbackInput,
): Promise<ActionResult & { id?: string }> {
  const parsed = Feedback.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('submit_feedback', {
    p_kind: parsed.data.kind,
    p_body: parsed.data.body,
    p_metadata: parsed.data.path ? { path: parsed.data.path } : {},
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: data as unknown as string };
}
