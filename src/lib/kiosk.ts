import 'server-only';
import { cookies } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/server';
import type { ActivityEntry, Balance, Chore, KioskMessage, Profile, TurnCard } from '@/lib/types';

export const KIOSK_COOKIE = 'domestic_kiosk';

/**
 * The wall tablet has no user. It authenticates with a device token issued by
 * an admin, passed once as ?token=... and then kept in an httpOnly cookie so it
 * never sits in the address bar where a guest could read it off the wall.
 *
 * The token resolves to the household that issued it — the display is bound to
 * one house, which is what makes this safe to run for more than one household.
 */
export async function kioskHousehold(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(KIOSK_COOKIE)?.value;
  if (!token) return null;
  return resolveKioskToken(token);
}

/**
 * Looks a raw token up by hash; never compares secrets in application code.
 * `kind` matters — a kiosk token must not unlock the Home Assistant surface.
 */
export async function resolveDeviceToken(
  token: string,
  kind: 'kiosk' | 'home_assistant',
): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('resolve_device_token', {
    p_token: token,
    p_kind: kind,
  });
  if (error) {
    console.error('[devices] token lookup failed', error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

export const resolveKioskToken = (token: string) => resolveDeviceToken(token, 'kiosk');

export type KioskSwap = {
  id: string;
  message: string | null;
  requested_to: string;
  chore_name: string;
  requester_name: string;
};

/** Verb -> the chore_turns status that makes its "Undo" meaningful (mirrors
 * the Activity page's own copy of this table). */
export const UNDOABLE_STATUS: Record<string, string> = {
  completed_chore: 'done',
  skipped_chore: 'skipped',
};

export type KioskData = {
  household: {
    id: string;
    name: string;
    timezone: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  members: Profile[];
  chores: Chore[];
  upNext: TurnCard[];
  balances: Record<string, number>;
  activity: ActivityEntry[];
  turnStatus: Record<string, string>;
  modules: string[];
  swaps: KioskSwap[];
  messages: KioskMessage[];
};

const TURN_SELECT = `
  id, chore_id, household_id, turn_number, assignee_id, status,
  due_at, completed_at, completed_by, note, created_at, flagged_at,
  chore:chores!inner ( id, name, emoji, cadence, description, days_of_week, interval_weeks, allow_get_ahead, allow_defer ),
  assignee:profiles!chore_turns_assignee_id_fkey ( id, full_name, initials, color )
`;

/**
 * Reads with the service role — there is no user session to scope RLS by, so
 * every query below is filtered by the household id the device token resolved
 * to. That filter is the security boundary here; do not remove it.
 */
export async function loadKiosk(householdId: string): Promise<KioskData | null> {
  const admin = createAdminClient();

  const { data: household } = await admin
    .from('households')
    .select('id, name, timezone, address, latitude, longitude')
    .eq('id', householdId)
    .single<{
      id: string; name: string; timezone: string;
      address: string | null; latitude: number | null; longitude: number | null;
    }>();

  if (!household) return null;

  const { data: modules } = await admin.rpc('enabled_modules', { p_household: household.id });

  const [
    { data: members }, { data: chores }, { data: turns }, { data: balances },
    { data: activity }, { data: swaps }, { data: messages },
  ] = await Promise.all([
      admin.from('profiles').select('*').eq('household_id', household.id)
        .order('initials').returns<Profile[]>(),
      admin.from('chores').select('*').eq('household_id', household.id)
        .eq('is_active', true).order('sort_order').returns<Chore[]>(),
      admin.from('chore_turns').select(TURN_SELECT)
        .eq('household_id', household.id).eq('status', 'pending')
        .order('turn_number').returns<TurnCard[]>(),
      admin.from('v_balances').select('*')
        .eq('household_id', household.id).returns<Balance[]>(),
      admin.from('activity_log').select('*')
        .eq('household_id', household.id)
        .order('created_at', { ascending: false }).limit(8).returns<ActivityEntry[]>(),
      admin.from('chore_swaps')
        .select(`
          id, message, requested_to, status,
          turn:chore_turns!inner ( household_id, chore:chores ( name ) ),
          requester:profiles!chore_swaps_requested_by_fkey ( full_name )
        `)
        .eq('status', 'pending')
        .eq('turn.household_id', household.id)
        .returns<{ id: string; message: string | null; requested_to: string; turn: { chore: { name: string } }; requester: { full_name: string } }[]>(),
      admin.from('kiosk_messages').select('*')
        .eq('household_id', household.id)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }).limit(3).returns<KioskMessage[]>(),
    ]);

  // One row per chore: whoever is actually up.
  const seen = new Set<string>();
  const upNext = (turns ?? []).filter((t) => {
    if (seen.has(t.chore_id)) return false;
    seen.add(t.chore_id);
    return true;
  });

  // Batch-fetch the current status of every turn a completion/skip entry in
  // "Lately" points at, so Undo only shows where it would actually do
  // something — same check the Activity page does with its own session client.
  const turnIds = [...new Set(
    (activity ?? [])
      .filter((a) => a.verb in UNDOABLE_STATUS)
      .map((a) => a.metadata.turn_id)
      .filter((id): id is string => typeof id === 'string'),
  )];
  const { data: turnRows } = turnIds.length
    ? await admin.from('chore_turns').select('id, status').in('id', turnIds)
      .returns<{ id: string; status: string }[]>()
    : { data: [] as { id: string; status: string }[] };
  const turnStatus = Object.fromEntries((turnRows ?? []).map((t) => [t.id, t.status]));

  return {
    household,
    members: members ?? [],
    chores: chores ?? [],
    upNext,
    balances: Object.fromEntries((balances ?? []).map((b) => [b.profile_id, b.net_cents])),
    activity: activity ?? [],
    turnStatus,
    modules: (modules as string[] | null) ?? [],
    swaps: (swaps ?? []).map((s) => ({
      id: s.id,
      message: s.message,
      requested_to: s.requested_to,
      chore_name: s.turn.chore.name,
      requester_name: s.requester.full_name,
    })),
    messages: messages ?? [],
  };
}
