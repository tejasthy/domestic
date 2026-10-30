'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import type { ActionResult } from '@/lib/actions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cuts one assistant off from the signed-in person's account. Supabase marks
 * the consent revoked, deletes that client's sessions, and invalidates its
 * refresh tokens, so the assistant's next call is simply unauthorized. It
 * acts only on the caller's own grant; nobody can disconnect a housemate's.
 */
export async function disconnectAssistant(clientId: string): Promise<ActionResult> {
  if (!UUID.test(clientId)) return { ok: false, error: 'That is not a valid assistant.' };

  const supabase = await createClient();
  const { error } = await supabase.auth.oauth.revokeGrant({ clientId });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}
