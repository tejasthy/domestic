// Hand-written to match supabase/migrations. Once the project is live you can
// regenerate with:  npx supabase gen types typescript --project-id <id>

export type ChoreCadence = 'scheduled' | 'on_demand' | 'standing';
export type TurnStatus = 'pending' | 'done' | 'skipped' | 'missed';
export type SplitKind = 'equal' | 'exact' | 'shares' | 'percent' | 'adjustment';
/** expenses.split_kind only — means "derive the split from expense_items". */
export type ExpenseSplitKind = SplitKind | 'itemized';
export type ExpenseItemKind = 'item' | 'tax' | 'tip' | 'discount' | 'fee';
export type SwapStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
export type RecurringCadence = 'weekly' | 'monthly';
export type AiProvider = 'anthropic' | 'gemini';

export type Household = {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  allow_member_cross_complete: boolean;
  location_label: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_enabled: boolean;
  geofence_radius_meters: number;
  signup_source: string | null;
  created_at: string;
};

export type Profile = {
  id: string;
  household_id: string | null;
  full_name: string;
  initials: string;
  email: string | null;
  color: string;
  avatar_url: string | null;
  is_admin: boolean;
  notify_push: boolean;
  notify_email: boolean;
  quiet_from: number;
  quiet_to: number;
  intro_seen_at: string | null;
  created_at: string;
  /** Populated by getSession() from member_away; not a `profiles` column. */
  away?: MemberAway;
};

export type MemberAway = { since: string; until: string | null } | null;

export type MemberAwayRow = {
  id: string;
  profile_id: string;
  household_id: string;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
};

export type Chore = {
  id: string;
  household_id: string;
  name: string;
  emoji: string;
  description: string | null;
  cadence: ChoreCadence;
  days_of_week: number[];
  interval_weeks: number;
  anchor_date: string;
  due_hour: number;
  queue_depth: number;
  lookahead_days: number;
  sort_order: number;
  is_active: boolean;
  created_at: string;
};

export type ChoreRotation = {
  chore_id: string;
  profile_id: string;
  position: number;
};

export type ChoreTurn = {
  id: string;
  chore_id: string;
  household_id: string;
  turn_number: number;
  assignee_id: string;
  status: TurnStatus;
  due_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  note: string | null;
  created_at: string;
  flagged_for: string | null;
  flagged_by: string | null;
  flagged_at: string | null;
  flag_note: string | null;
  completion_distance_m: number | null;
  completion_within_geofence: boolean | null;
};

export type ChoreAdvanceKind = 'get_ahead' | 'defer';

export type ChoreAdvanceLog = {
  id: string;
  chore_id: string;
  profile_id: string;
  kind: ChoreAdvanceKind;
  turn_id: string;
  created_at: string;
};

export type ChoreSwap = {
  id: string;
  turn_id: string;
  requested_by: string;
  requested_to: string;
  status: SwapStatus;
  message: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type Expense = {
  id: string;
  household_id: string;
  description: string;
  amount_cents: number;
  currency: string;
  category: string;
  paid_by: string;
  spent_on: string;
  split_kind: ExpenseSplitKind;
  receipt_url: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type ExpenseSplit = {
  expense_id: string;
  profile_id: string;
  owed_cents: number;
  weight: number | null;
};

export type ExpenseItem = {
  id: string;
  expense_id: string;
  name: string;
  amount_cents: number;
  kind: ExpenseItemKind;
  split_kind: SplitKind;
  position: number;
  created_at: string;
};

export type ExpenseItemSplit = {
  expense_item_id: string;
  profile_id: string;
  owed_cents: number;
  weight: number | null;
};

export type RecurringExpense = {
  id: string;
  household_id: string;
  description: string;
  amount_cents: number;
  currency: string;
  category: string;
  paid_by: string;
  split_kind: SplitKind;
  cadence: RecurringCadence;
  interval_weeks: number;
  interval_months: number;
  day_of_month: number | null;
  next_run_on: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
};

export type RecurringExpenseParticipant = {
  recurring_expense_id: string;
  profile_id: string;
  owed_cents: number;
  weight: number | null;
};

export type Settlement = {
  id: string;
  household_id: string;
  from_profile: string;
  to_profile: string;
  amount_cents: number;
  settled_on: string;
  method: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

export type PushSubscriptionRow = {
  id: string;
  profile_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
};

export type HouseholdInvite = {
  id: string;
  household_id: string;
  code: string;
  email: string | null;
  full_name: string | null;
  initials: string | null;
  color: string;
  is_admin: boolean;
  created_by: string | null;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  revoked_at: string | null;
  created_at: string;
};

export type HouseholdModule = {
  household_id: string;
  module: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  updated_at: string;
  updated_by: string | null;
};

export type KioskDevice = {
  id: string;
  household_id: string;
  name: string;
  token_hash: string;
  last_seen_at: string | null;
  created_at: string;
};

export type KioskMessage = {
  id: string;
  household_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
  expires_at: string;
};

export type ActivityEntry = {
  id: number;
  household_id: string;
  actor_id: string | null;
  verb: string;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type Balance = {
  household_id: string;
  profile_id: string;
  net_cents: number;
};

export type ChoreStat = {
  household_id: string;
  chore_id: string;
  profile_id: string;
  done_count: number;
  missed_count: number;
  last_done_at: string | null;
};

/* -------------------------------------------------------------------------
   Database shape for @supabase/supabase-js.

   `Insert` makes server-defaulted columns optional; `Update` makes everything
   optional. Without these, every .insert()/.update() call infers `never` and
   the compiler rejects perfectly good payloads.
------------------------------------------------------------------------- */

type Defaulted =
  | 'id' | 'created_at' | 'updated_at' | 'currency' | 'color' | 'is_admin'
  | 'notify_push' | 'notify_email' | 'quiet_from' | 'quiet_to' | 'timezone'
  | 'emoji' | 'days_of_week' | 'interval_weeks' | 'anchor_date' | 'due_hour'
  | 'queue_depth' | 'lookahead_days' | 'sort_order' | 'is_active' | 'status'
  | 'spent_on' | 'settled_on' | 'split_kind' | 'category' | 'method'
  | 'metadata' | 'turn_number' | 'position' | 'interval_months' | 'next_run_on'
  | 'allow_member_cross_complete' | 'expires_at' | 'starts_at'
  | 'geofence_enabled' | 'geofence_radius_meters';

/** Nullable columns are optional on insert too — Postgres fills them with NULL. */
type NullableKeys<Row> = {
  [K in keyof Row]-?: null extends Row[K] ? K : never;
}[keyof Row];

type OptionalOnInsert<Row> = Extract<keyof Row, Defaulted> | NullableKeys<Row>;

type Table<Row> = {
  Row: Row;
  Insert: Omit<Row, OptionalOnInsert<Row>> & Partial<Pick<Row, OptionalOnInsert<Row>>>;
  Update: Partial<Row>;
  Relationships: [];
};

type View<Row> = { Row: Row; Relationships: [] };

export type Database = {
  public: {
    Tables: {
      households: Table<Household>;
      profiles: Table<Profile>;
      chores: Table<Chore>;
      chore_rotation: Table<ChoreRotation>;
      chore_turns: Table<ChoreTurn>;
      chore_swaps: Table<ChoreSwap>;
      expenses: Table<Expense>;
      expense_splits: Table<ExpenseSplit>;
      expense_items: Table<ExpenseItem>;
      expense_item_splits: Table<ExpenseItemSplit>;
      recurring_expenses: Table<RecurringExpense>;
      recurring_expense_participants: Table<RecurringExpenseParticipant>;
      settlements: Table<Settlement>;
      push_subscriptions: Table<PushSubscriptionRow>;
      kiosk_devices: Table<KioskDevice>;
      household_invites: Table<HouseholdInvite>;
      household_modules: Table<HouseholdModule>;
      kiosk_messages: Table<KioskMessage>;
      activity_log: Table<ActivityEntry>;
      member_away: Table<MemberAwayRow>;
      chore_advance_log: Table<ChoreAdvanceLog>;
    };
    Views: {
      v_balances: View<Balance>;
      v_chore_stats: View<ChoreStat>;
    };
    Functions: {
      current_household_id: { Args: Record<PropertyKey, never>; Returns: string };
      is_household_member: { Args: { target: string }; Returns: boolean };
      rotation_assignee: { Args: { p_chore: string; p_turn: number; p_at?: string }; Returns: string };
      is_away_at: { Args: { p_profile: string; p_at?: string }; Returns: boolean };
      pass_turn: { Args: { p_turn: string; p_note?: string | null }; Returns: ChoreTurn };
      set_away: { Args: { p_until?: string | null }; Returns: MemberAwayRow };
      clear_away: { Args: Record<PropertyKey, never>; Returns: void };
      append_turn: { Args: { p_chore: string; p_due?: string | null }; Returns: ChoreTurn };
      top_up_queue: { Args: { p_chore: string }; Returns: number };
      materialize_schedule: { Args: { p_chore: string }; Returns: number };
      complete_turn: {
        Args: {
          p_turn: string;
          p_note?: string | null;
          p_lat?: number | null;
          p_lon?: number | null;
        };
        Returns: ChoreTurn;
      };
      skip_turn: { Args: { p_turn: string; p_note?: string | null }; Returns: ChoreTurn };
      undo_turn: { Args: { p_turn: string }; Returns: ChoreTurn };
      flag_on_demand: { Args: { p_chore: string }; Returns: ChoreTurn };
      flag_turn: {
        Args: { p_turn: string; p_target: string; p_message?: string | null };
        Returns: ChoreTurn;
      };
      clear_flag: { Args: { p_turn: string }; Returns: ChoreTurn };
      get_ahead: { Args: { p_chore: string }; Returns: ChoreTurn };
      defer_turn: { Args: { p_turn: string }; Returns: ChoreTurn };
      haversine_meters: {
        Args: { lat1: number; lon1: number; lat2: number; lon2: number };
        Returns: number;
      };
      set_geofence: {
        Args: { p_enabled: boolean; p_radius_meters?: number | null };
        Returns: undefined;
      };
      accept_swap: { Args: { p_swap: string }; Returns: undefined };
      is_household_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_platform_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      submit_feedback: {
        Args: { p_kind: string; p_body: string; p_metadata?: Record<string, unknown> | null };
        Returns: string;
      };
      platform_stats: {
        Args: Record<PropertyKey, never>;
        Returns: {
          households_total: number;
          households_last_30d: number;
          members_total: number;
          members_last_30d: number;
          admins_total: number;
          module_enabled_counts: Record<string, number>;
          turns_completed_last_7d: number;
          turns_completed_last_30d: number;
          turns_skipped_last_30d: number;
          cross_complete_enabled_count: number;
          geofence_enabled_count: number;
          signup_source_counts: Record<string, number>;
          feedback_total: number;
          feedback_last_30d: number;
        }[];
      };
      platform_households_summary: {
        Args: { p_limit?: number };
        Returns: {
          id: string;
          created_at: string;
          member_count: number;
          modules_enabled: string[];
          allow_member_cross_complete: boolean;
          geofence_enabled: boolean;
          signup_source: string | null;
        }[];
      };
      platform_feedback: {
        Args: { p_limit?: number };
        Returns: {
          id: string;
          household_name: string | null;
          submitter_name: string | null;
          kind: string;
          body: string;
          metadata: Record<string, unknown>;
          created_at: string;
        }[];
      };
      create_household: {
        Args: {
          p_name: string;
          p_address?: string | null;
          p_timezone?: string;
          p_full_name?: string | null;
          p_initials?: string | null;
          p_modules?: string[] | null;
          p_signup_source?: string | null;
        };
        Returns: string;
      };
      create_invite: {
        Args: {
          p_email?: string | null;
          p_full_name?: string | null;
          p_initials?: string | null;
          p_color?: string;
          p_expires_in?: string;
          p_max_uses?: number;
        };
        Returns: HouseholdInvite;
      };
      revoke_invite: { Args: { p_invite: string }; Returns: undefined };
      peek_invite: {
        Args: { p_code: string };
        Returns: {
          household_name: string | null;
          full_name: string | null;
          initials: string | null;
          valid: boolean;
          reason: string | null;
        }[];
      };
      redeem_invite: {
        Args: { p_code: string; p_full_name?: string | null; p_initials?: string | null };
        Returns: string;
      };
      remove_member: { Args: { p_profile: string }; Returns: undefined };
      set_member_admin: { Args: { p_profile: string; p_is_admin: boolean }; Returns: undefined };
      create_kiosk_device: { Args: { p_name: string }; Returns: string };
      resolve_kiosk_token: { Args: { p_token: string }; Returns: string | null };
      create_device: { Args: { p_name: string; p_kind?: string }; Returns: string };
      resolve_device_token: {
        Args: { p_token: string; p_kind?: string | null };
        Returns: string | null;
      };
      set_module: {
        Args: { p_module: string; p_enabled: boolean; p_settings?: Record<string, unknown> | null };
        Returns: undefined;
      };
      enabled_modules: { Args: { p_household: string }; Returns: string[] };
      default_modules: { Args: Record<PropertyKey, never>; Returns: string[] };
      resync_pending_turns: { Args: { p_chore: string }; Returns: number };
      create_chore: {
        Args: {
          p_name: string;
          p_cadence: ChoreCadence;
          p_emoji?: string;
          p_description?: string | null;
          p_days_of_week?: number[];
          p_interval_weeks?: number;
          p_due_hour?: number;
          p_queue_depth?: number;
          p_lookahead_days?: number;
          p_profile_ids?: string[];
        };
        Returns: Chore;
      };
      update_chore: {
        Args: {
          p_chore: string;
          p_name?: string | null;
          p_emoji?: string | null;
          p_description?: string | null;
          p_cadence?: ChoreCadence | null;
          p_days_of_week?: number[] | null;
          p_interval_weeks?: number | null;
          p_due_hour?: number | null;
          p_queue_depth?: number | null;
          p_lookahead_days?: number | null;
          p_sort_order?: number | null;
        };
        Returns: Chore;
      };
      set_chore_active: { Args: { p_chore: string; p_active: boolean }; Returns: undefined };
      set_chore_rotation: { Args: { p_chore: string; p_profile_ids: string[] }; Returns: undefined };
      create_recurring_expense: {
        Args: {
          p_description: string;
          p_amount_cents: number;
          p_paid_by: string;
          p_split_kind: SplitKind;
          p_cadence: RecurringCadence;
          p_participants: { profile_id: string; owed_cents: number; weight: number | null }[];
          p_category?: string;
          p_interval_weeks?: number;
          p_interval_months?: number;
          p_day_of_month?: number | null;
          p_start_on?: string;
        };
        Returns: RecurringExpense;
      };
      update_recurring_expense: {
        Args: {
          p_id: string;
          p_description?: string | null;
          p_amount_cents?: number | null;
          p_paid_by?: string | null;
          p_split_kind?: SplitKind | null;
          p_category?: string | null;
          p_cadence?: RecurringCadence | null;
          p_interval_weeks?: number | null;
          p_interval_months?: number | null;
          p_day_of_month?: number | null;
          p_participants?: { profile_id: string; owed_cents: number; weight: number | null }[] | null;
        };
        Returns: RecurringExpense;
      };
      create_itemized_expense: {
        Args: {
          p_description: string;
          p_paid_by: string;
          p_spent_on: string;
          p_items: {
            name: string;
            amount_cents: number;
            kind: ExpenseItemKind;
            split_kind: SplitKind;
            position?: number;
            splits: { profile_id: string; owed_cents: number; weight: number | null }[];
          }[];
          p_category?: string;
          p_receipt_url?: string | null;
          p_note?: string | null;
        };
        Returns: Expense;
      };
      update_expense: {
        Args: {
          p_expense_id: string;
          p_description: string;
          p_paid_by: string;
          p_spent_on: string;
          p_category?: string;
          p_receipt_url?: string | null;
          p_note?: string | null;
          p_items?: {
            name: string;
            amount_cents: number;
            kind: ExpenseItemKind;
            split_kind: SplitKind;
            position?: number;
            splits: { profile_id: string; owed_cents: number; weight: number | null }[];
          }[] | null;
          p_split_kind?: SplitKind;
          p_splits?: { profile_id: string; owed_cents: number; weight: number | null }[] | null;
        };
        Returns: Expense;
      };
      set_recurring_expense_active: { Args: { p_id: string; p_active: boolean }; Returns: undefined };
      post_due_recurring_expenses: { Args: Record<PropertyKey, never>; Returns: Expense[] };
      set_ai_config: { Args: { p_provider: AiProvider; p_api_key: string; p_secret: string }; Returns: undefined };
      clear_ai_config: { Args: Record<PropertyKey, never>; Returns: undefined };
      get_ai_config_summary: {
        Args: Record<PropertyKey, never>;
        Returns: { provider: AiProvider; updated_at: string }[];
      };
      get_ai_credentials: {
        Args: { p_secret: string };
        Returns: { provider: AiProvider; api_key: string }[];
      };
      set_cross_complete: { Args: { p_enabled: boolean }; Returns: undefined };
      set_household_location: {
        Args: { p_label: string | null; p_lat: number | null; p_lon: number | null };
        Returns: undefined;
      };
      kiosk_complete_turn: {
        Args: { p_household: string; p_turn: string; p_profile: string; p_note?: string | null };
        Returns: ChoreTurn;
      };
      kiosk_flag_chore: {
        Args: { p_household: string; p_chore: string; p_profile: string };
        Returns: ChoreTurn;
      };
      kiosk_respond_swap: {
        Args: { p_household: string; p_swap: string; p_profile: string; p_accept: boolean };
        Returns: undefined;
      };
      kiosk_set_chore_active: {
        Args: { p_household: string; p_chore: string; p_profile: string; p_active: boolean };
        Returns: undefined;
      };
      kiosk_dismiss_message: {
        Args: { p_household: string; p_message: string; p_profile: string };
        Returns: undefined;
      };
      kiosk_undo_turn: {
        Args: { p_household: string; p_turn: string; p_profile: string };
        Returns: ChoreTurn;
      };
    };
    Enums: {
      chore_cadence: ChoreCadence;
      turn_status: TurnStatus;
      split_kind: ExpenseSplitKind;
    };
    CompositeTypes: Record<never, never>;
  };
};

/** A turn joined to its chore and assignee — what the UI actually renders. */
export type TurnCard = ChoreTurn & {
  chore: Pick<
    Chore,
    'id' | 'name' | 'emoji' | 'cadence' | 'description' | 'days_of_week' | 'interval_weeks'
  >;
  assignee: Pick<Profile, 'id' | 'full_name' | 'initials' | 'color'>;
  flagger: Pick<Profile, 'id' | 'full_name' | 'initials' | 'color'> | null;
  flagged: Pick<Profile, 'id' | 'full_name' | 'initials' | 'color'> | null;
};
