import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type {
  ActivityEntry, Balance, Chore, Expense, ExpenseSplit, HouseholdInvite,
  Profile, RecurringExpense, RecurringExpenseParticipant, Settlement, TurnCard,
} from '@/lib/types';
import { DEFAULT_MODULES, type ModuleKey } from '@/lib/modules';

const TURN_SELECT = `
  id, chore_id, household_id, turn_number, assignee_id, status,
  due_at, completed_at, completed_by, note, created_at,
  chore:chores!inner ( id, name, emoji, cadence, description, days_of_week, interval_weeks ),
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

  const [{ data: household }, { data: members }, { data: modules }] = await Promise.all([
    supabase.from('households').select('*').eq('id', me.household_id).single(),
    supabase
      .from('profiles')
      .select('*')
      .eq('household_id', me.household_id)
      .order('initials')
      .returns<Profile[]>(),
    supabase.rpc('enabled_modules', { p_household: me.household_id }),
  ]);

  return {
    me,
    household,
    members: members ?? [],
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
};

export async function getExpenses(limit = 50): Promise<ExpenseWithSplits[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('expenses')
    .select(`
      *,
      splits:expense_splits ( expense_id, profile_id, owed_cents, weight ),
      payer:profiles!expenses_paid_by_fkey ( id, full_name, initials, color )
    `)
    .is('deleted_at', null)
    .order('spent_on', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)
    .returns<ExpenseWithSplits[]>();
  return data ?? [];
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
export async function requireModule(key: ModuleKey) {
  const session = await getSession();
  if (!session?.me || !session.household) redirect('/');
  if (!session.modules.includes(key)) notFound();
  return session;
}
