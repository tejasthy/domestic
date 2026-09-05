import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type {
  ActivityEntry, Balance, Chore, Expense, ExpenseSplit, ExpenseItem, ExpenseItemSplit,
  Household, HouseholdInvite, KioskMessage, MemberAwayRow, Profile, RecurringExpense,
  RecurringExpenseParticipant, Settlement, TurnCard,
} from '@/lib/types';
import { DEFAULT_MODULES, type ModuleKey } from '@/lib/modules';

const TURN_SELECT = `
  id, chore_id, household_id, turn_number, assignee_id, status,
  due_at, completed_at, completed_by, note, created_at, flagged_at,
  completion_distance_m, completion_within_geofence,
  chore:chores!inner ( id, name, emoji, cadence, description, days_of_week, interval_weeks, allow_get_ahead, allow_defer ),
  assignee:profiles!chore_turns_assignee_id_fkey ( id, full_name, initials, color )
`;

/** Current user's profile plus everyone they live with. Cached per request. */
export const getSession = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: me } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single<Profile>();

  if (!me?.household_id) {
    return {
      me: me ?? null,
      household: null,
      members: [] as Profile[],
      modules: [] as string[],
    };
  }

  const [{ data: household }, { data: members }, { data: modules }, { data: away }] = await Promise.all([
    supabase.from('households').select('*').eq('id', me.household_id).single(),
    supabase
      .from('profiles')
      .select('*')
      .eq('household_id', me.household_id)
      .order('initials')
      .returns<Profile[]>(),
    supabase.rpc('enabled_modules', { p_household: me.household_id }),
    supabase
      .from('member_away')
      .select('profile_id, starts_at, ends_at')
      .eq('household_id', me.household_id)
      .or(`ends_at.is.null,ends_at.gt.${new Date().toISOString()}`)
      .returns<Pick<MemberAwayRow, 'profile_id' | 'starts_at' | 'ends_at'>[]>(),
  ]);

  const awayByProfile = new Map(
    (away ?? []).map((a) => [a.profile_id, { since: a.starts_at, until: a.ends_at }]),
  );
  const withAway = (p: Profile): Profile => ({ ...p, away: awayByProfile.get(p.id) ?? null });

  return {
    me: withAway(me),
    household,
    members: (members ?? []).map(withAway),
    // If the RPC is unavailable (mid-migration), fall back to the defaults
    // rather than rendering a household with no navigation at all.
    modules: (modules as string[] | null) ?? DEFAULT_MODULES,
  };
});

export const getChores = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase
    .from('chores')
    .select('*')
    .eq('is_active', true)
    .order('sort_order')
    .returns<Chore[]>();
  return data ?? [];
});

/**
 * Everything currently open. Scheduled turns beyond the horizon are dropped so
 * the list stays the size of a fridge chart rather than a calendar export.
 */
export async function getOpenTurns(horizonDays = 10): Promise<TurnCard[]> {
  const supabase = await createClient();
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + horizonDays);

  const { data } = await supabase
    .from('chore_turns')
    .select(TURN_SELECT)
    .eq('status', 'pending')
    .or(`due_at.is.null,due_at.lte.${horizon.toISOString()}`)
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('turn_number', { ascending: true })
    .returns<TurnCard[]>();

  return data ?? [];
}

/** The next pending turn for each chore — "who's up", one row per chore. */
export async function getUpNext(): Promise<TurnCard[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('chore_turns')
    .select(TURN_SELECT)
    .eq('status', 'pending')
    .order('turn_number', { ascending: true })
    .returns<TurnCard[]>();

  const seen = new Set<string>();
  return (data ?? []).filter((t) => {
    if (seen.has(t.chore_id)) return false;
    seen.add(t.chore_id);
    return true;
  });
}

export async function getRecentlyDone(limit = 20): Promise<TurnCard[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('chore_turns')
    .select(TURN_SELECT)
    .eq('status', 'done')
    .order('completed_at', { ascending: false })
    .limit(limit)
    .returns<TurnCard[]>();
  return data ?? [];
}

/** Notes currently live on the wall display, newest first. */
export async function getKioskMessages(): Promise<KioskMessage[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('kiosk_messages')
    .select('*')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .returns<KioskMessage[]>();
  return data ?? [];
}

export async function getActivity(limit = 30): Promise<ActivityEntry[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('activity_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<ActivityEntry[]>();
  return data ?? [];
}

/* ------------------------------------------------------------------- money */

export type ExpenseWithSplits = Expense & {
  splits: ExpenseSplit[];
  payer: Pick<Profile, 'id' | 'full_name' | 'initials' | 'color'>;
  items: (ExpenseItem & { item_splits: ExpenseItemSplit[] })[];
};

export async function getExpenses(limit = 50): Promise<ExpenseWithSplits[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('expenses')
    .select(`
      *,
      splits:expense_splits ( expense_id, profile_id, owed_cents, weight ),
      payer:profiles!expenses_paid_by_fkey ( id, full_name, initials, color ),
      items:expense_items (
        id, expense_id, name, amount_cents, kind, split_kind, position, created_at,
        item_splits:expense_item_splits ( expense_item_id, profile_id, owed_cents, weight )
      )
    `)
    .is('deleted_at', null)
    .order('spent_on', { ascending: false })
    .order('created_at', { ascending: false })
    .order('position', { referencedTable: 'expense_items' })
    .limit(limit)
    .returns<ExpenseWithSplits[]>();
  return data ?? [];
}

export async function getExpense(id: string): Promise<ExpenseWithSplits | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('expenses')
    .select(`
      *,
      splits:expense_splits ( expense_id, profile_id, owed_cents, weight ),
      payer:profiles!expenses_paid_by_fkey ( id, full_name, initials, color ),
      items:expense_items (
        id, expense_id, name, amount_cents, kind, split_kind, position, created_at,
        item_splits:expense_item_splits ( expense_item_id, profile_id, owed_cents, weight )
      )
    `)
    .eq('id', id)
    .is('deleted_at', null)
    .order('position', { referencedTable: 'expense_items' })
    .single<ExpenseWithSplits>();
  return data ?? null;
}

export type RecurringExpenseWithParticipants = RecurringExpense & {
  participants: RecurringExpenseParticipant[];
};

export async function getRecurringExpenses(): Promise<RecurringExpenseWithParticipants[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('recurring_expenses')
    .select('*, participants:recurring_expense_participants ( recurring_expense_id, profile_id, owed_cents, weight )')
    .order('next_run_on', { ascending: true })
    .returns<RecurringExpenseWithParticipants[]>();
  return data ?? [];
}

export async function getRecurringExpense(id: string): Promise<RecurringExpenseWithParticipants | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('recurring_expenses')
    .select('*, participants:recurring_expense_participants ( recurring_expense_id, profile_id, owed_cents, weight )')
    .eq('id', id)
    .single<RecurringExpenseWithParticipants>();
  return data ?? null;
}

export async function getBalances(): Promise<Record<string, number>> {
  const supabase = await createClient();
  const { data } = await supabase.from('v_balances').select('*').returns<Balance[]>();
  return Object.fromEntries((data ?? []).map((b) => [b.profile_id, b.net_cents]));
}

export async function getSettlements(limit = 20): Promise<Settlement[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('settlements')
    .select('*')
    .order('settled_on', { ascending: false })
    .limit(limit)
    .returns<Settlement[]>();
  return data ?? [];
}

/** done/missed counts per person per chore, for the fair-share view. */
export async function getChoreStats() {
  const supabase = await createClient();
  const { data } = await supabase
    .from('v_chore_stats')
    .select('*')
    .returns<{ chore_id: string; profile_id: string; done_count: number; missed_count: number; last_done_at: string | null }[]>();
  return data ?? [];
}

/** Whether this profile has ever completed a real push subscription — distinct
 * from notify_push, which is just the pause/resume preference. */
export async function hasPushSubscription(profileId: string): Promise<boolean> {
  const supabase = await createClient();
  const { count } = await supabase
    .from('push_subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', profileId);
  return (count ?? 0) > 0;
}

/* ------------------------------------------------------------ household admin */

export async function getInvites(): Promise<HouseholdInvite[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('household_invites')
    .select('*')
    .order('created_at', { ascending: false })
    .returns<HouseholdInvite[]>();
  return data ?? [];
}

export type GetAheadSettings = {
  enabled: boolean;
  getAhead: { maxPer30d: number };
  defer: { maxPer30d: number; maxChain: number };
};

const GET_AHEAD_DEFAULTS: Omit<GetAheadSettings, 'defer'> & { defer: { maxPer30d: number } } = {
  enabled: true,
  getAhead: { maxPer30d: 1 },
  defer: { maxPer30d: 1 },
};

/**
 * No row for this household means the feature is on with the defaults — the
 * same fallback get_ahead()/defer_turn() apply server-side, kept in sync here
 * so the settings screen and button-disabled states agree with the RPCs.
 * defer.maxChain caps how many times a single turn can be handed off in a
 * row (a defer chain can otherwise cascade through the whole rotation and
 * back, forever) — it defaults to the household's own member count, same as
 * the RPC, rather than a fixed number. Everything else is a plain
 * rolling-30-day use count per person, since both directions are
 * queue-position swaps, not completing/pushing a due date.
 */
export async function getGetAheadSettings(
  householdId: string,
  memberCount: number,
): Promise<GetAheadSettings> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('household_modules')
    .select('enabled, settings')
    .eq('household_id', householdId)
    .eq('module', 'get_ahead')
    .maybeSingle<{ enabled: boolean; settings: Record<string, unknown> }>();

  const defaultMaxChain = Math.max(memberCount, 1);
  if (!data) return { ...GET_AHEAD_DEFAULTS, defer: { ...GET_AHEAD_DEFAULTS.defer, maxChain: defaultMaxChain } };

  const settings = (data.settings ?? {}) as {
    get_ahead?: { max_per_30d?: number };
    defer?: { max_per_30d?: number; max_chain?: number };
  };

  return {
    enabled: data.enabled ?? true,
    getAhead: {
      maxPer30d: settings.get_ahead?.max_per_30d ?? GET_AHEAD_DEFAULTS.getAhead.maxPer30d,
    },
    defer: {
      maxPer30d: settings.defer?.max_per_30d ?? GET_AHEAD_DEFAULTS.defer.maxPer30d,
      maxChain: settings.defer?.max_chain ?? defaultMaxChain,
    },
  };
}

export async function getKioskDevices() {
  const supabase = await createClient();
  const { data } = await supabase
    .from('kiosk_devices')
    .select('id, name, last_seen_at, created_at')
    .order('created_at')
    .returns<{ id: string; name: string; last_seen_at: string | null; created_at: string }[]>();
  return data ?? [];
}

/**
 * Page-level guard. A route whose module is switched off should not exist for
 * that household — notFound() rather than an empty screen, so nothing leaks
 * about a component they chose not to run.
 */
/* ------------------------------------------------------------ platform admin */

/**
 * Every function here is gated by is_platform_admin() inside the RPC itself
 * (see supabase/migrations/0025 + 0027) — that's the real authorization
 * boundary. The route-level gate in src/app/platform-admin/layout.tsx only
 * controls whether the page exists; a non-admin calling these directly still
 * gets refused by Postgres.
 */
export async function getPlatformStats() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_stats');
  if (error) return null;
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

export async function getPlatformHouseholdsSummary(limit = 200) {
  const supabase = await createClient();
  const { data } = await supabase.rpc('platform_households_summary', { p_limit: limit });
  return data ?? [];
}

export async function getPlatformFeedback(limit = 100) {
  const supabase = await createClient();
  const { data } = await supabase.rpc('platform_feedback', { p_limit: limit });
  return data ?? [];
}

export async function requireModule(key: ModuleKey) {
  const session = await getSession();
  if (!session?.me || !session.household) redirect('/login');
  if (!session.modules.includes(key)) notFound();
  // The guard above already guarantees this at runtime; redirect()'s `never`
  // return type doesn't propagate narrowing through getSession's wider union.
  return session as typeof session & { me: Profile; household: Household };
}
