'use server';

import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/server';
import { kioskHousehold } from '@/lib/kiosk';
import type { ActionResult } from '@/lib/actions';

/**
 * The kiosk has no auth.uid() — every mutation here re-derives the household
 * from the device-token cookie (same as loadKiosk()) and calls a kiosk_*
 * RPC that takes that household id plus the "acting as" profile explicitly.
 * Those RPCs are locked to service_role, so this file — not the client — is
 * the only thing that can call them.
 */
async function kioskAdmin() {
  const householdId = await kioskHousehold();
  if (!householdId) return { ok: false as const, error: 'This kiosk is not paired.' };
  return { ok: true as const, householdId, admin: createAdminClient() };
}

export async function kioskCompleteTurn(
  turnId: string,
  profileId: string,
  note?: string,
): Promise<ActionResult> {
  const ctx = await kioskAdmin();
  if (!ctx.ok) return ctx;

  const { error } = await ctx.admin.rpc('kiosk_complete_turn', {
    p_household: ctx.householdId,
    p_turn: turnId,
    p_profile: profileId,
    p_note: note ?? null,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/kiosk');
  return { ok: true };
}

export async function kioskFlagChore(choreId: string, profileId: string): Promise<ActionResult> {
  const ctx = await kioskAdmin();
  if (!ctx.ok) return ctx;

  const { error } = await ctx.admin.rpc('kiosk_flag_chore', {
    p_household: ctx.householdId,
    p_chore: choreId,
    p_profile: profileId,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/kiosk');
  return { ok: true };
}

export async function kioskRespondSwap(
  swapId: string,
  profileId: string,
  accept: boolean,
): Promise<ActionResult> {
  const ctx = await kioskAdmin();
  if (!ctx.ok) return ctx;

  const { error } = await ctx.admin.rpc('kiosk_respond_swap', {
    p_household: ctx.householdId,
    p_swap: swapId,
    p_profile: profileId,
    p_accept: accept,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/kiosk');
  return { ok: true };
}

export async function kioskSetChoreActive(
  choreId: string,
  profileId: string,
  active: boolean,
): Promise<ActionResult> {
  const ctx = await kioskAdmin();
  if (!ctx.ok) return ctx;

  const { error } = await ctx.admin.rpc('kiosk_set_chore_active', {
    p_household: ctx.householdId,
    p_chore: choreId,
    p_profile: profileId,
    p_active: active,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/kiosk');
  return { ok: true };
}
