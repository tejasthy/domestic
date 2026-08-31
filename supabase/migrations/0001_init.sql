-- 526 Detroit St. — household chores + expenses
-- Core idea, taken straight from the paper chart on the fridge:
-- every chore owns a fixed rotation of roommates (AB -> BK -> TT -> NA) and a
-- monotonically increasing turn counter. Turn N belongs to
-- members[N % members.length]. Completing a turn materializes turn N+1.
-- Scheduled chores (Floors, weekly Trash) get a due date; on-demand chores
-- (Dishes per load, Trash when full) are just a numbered queue, like the
-- 16 numbered rows on the sheet.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- households

create table households (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  address     text,
  timezone    text        not null default 'America/Detroit',
  created_at  timestamptz not null default now()
);

create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  household_id  uuid        references households(id) on delete set null,
  full_name     text        not null,
  initials      text        not null,           -- 'AB', 'NA', 'TT', 'BK'
  email         text,
  color         text        not null default '#64748b',
  avatar_url    text,
  is_admin      boolean     not null default false,
  -- notification preferences
  notify_push   boolean     not null default true,
  notify_email  boolean     not null default false,
  quiet_from    smallint    not null default 22, -- local hour, inclusive
  quiet_to      smallint    not null default 8,  -- local hour, exclusive
  created_at    timestamptz not null default now()
);

create index on profiles (household_id);

-- ------------------------------------------------------------------- chores

create type chore_cadence as enum ('scheduled', 'on_demand');
create type turn_status   as enum ('pending', 'done', 'skipped', 'missed');

create table chores (
  id             uuid primary key default gen_random_uuid(),
  household_id   uuid not null references households(id) on delete cascade,
  name           text not null,
  emoji          text not null default '🧹',
  description    text,
  cadence        chore_cadence not null,

  -- scheduled cadence: "every `interval_weeks` weeks, on these weekdays"
  -- 0 = Sunday .. 6 = Saturday.  Floors = {0,5}; Microwave = {6} every 2 wks.
  days_of_week   smallint[] not null default '{}',
  interval_weeks smallint   not null default 1,
  anchor_date    date       not null default current_date,
  due_hour       smallint   not null default 20,  -- local hour the turn is "due"

  -- on-demand cadence: how many turns to keep visible in the queue
  queue_depth    smallint   not null default 4,

  -- how far ahead scheduled turns are materialized
  lookahead_days smallint   not null default 21,

  sort_order     smallint   not null default 0,
  is_active      boolean    not null default true,
  created_at     timestamptz not null default now()
);

create index on chores (household_id, is_active);

-- The rotation order for a chore. `position` is 0-based and defines the cycle.
create table chore_rotation (
  chore_id    uuid     not null references chores(id) on delete cascade,
  profile_id  uuid     not null references profiles(id) on delete cascade,
  position    smallint not null,
  primary key (chore_id, profile_id),
  unique (chore_id, position) deferrable initially deferred
);

-- One row = one box on the paper chart.
create table chore_turns (
  id            uuid primary key default gen_random_uuid(),
  chore_id      uuid     not null references chores(id) on delete cascade,
  household_id  uuid     not null references households(id) on delete cascade,
  turn_number   integer  not null,            -- monotonic, 0-based
  assignee_id   uuid     not null references profiles(id) on delete cascade,
  status        turn_status not null default 'pending',
  due_at        timestamptz,                  -- null for on-demand turns
  completed_at  timestamptz,
  completed_by  uuid     references profiles(id) on delete set null,
  note          text,
  created_at    timestamptz not null default now(),
  unique (chore_id, turn_number)
);

create index on chore_turns (household_id, status, due_at);
create index on chore_turns (chore_id, status, turn_number);
create index on chore_turns (assignee_id, status);

-- Swap a turn with another roommate. Requires the other person to accept.
create table chore_swaps (
  id            uuid primary key default gen_random_uuid(),
  turn_id       uuid not null references chore_turns(id) on delete cascade,
  requested_by  uuid not null references profiles(id) on delete cascade,
  requested_to  uuid not null references profiles(id) on delete cascade,
  status        text not null default 'pending'
                  check (status in ('pending','accepted','declined','cancelled')),
  message       text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create index on chore_swaps (requested_to, status);

-- ----------------------------------------------------------------- expenses

create type split_kind as enum ('equal', 'exact', 'shares', 'percent');

create table expenses (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  description   text not null,
  amount_cents  bigint not null check (amount_cents > 0),
  currency      char(3) not null default 'USD',
  category      text not null default 'general',
  paid_by       uuid not null references profiles(id) on delete restrict,
  spent_on      date not null default current_date,
  split_kind    split_kind not null default 'equal',
  receipt_url   text,
  note          text,
  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index on expenses (household_id, spent_on desc) where deleted_at is null;

-- Who owes what on a given expense. owed_cents across an expense must sum to
-- amount_cents; enforced in the app + a deferred trigger below.
create table expense_splits (
  expense_id  uuid   not null references expenses(id) on delete cascade,
  profile_id  uuid   not null references profiles(id) on delete cascade,
  owed_cents  bigint not null check (owed_cents >= 0),
  weight      numeric(10,4),   -- shares or percent, kept for re-editing
  primary key (expense_id, profile_id)
);

-- A real transfer of money between two roommates (Venmo, cash, etc).
create table settlements (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  from_profile  uuid not null references profiles(id) on delete restrict,
  to_profile    uuid not null references profiles(id) on delete restrict,
  amount_cents  bigint not null check (amount_cents > 0),
  settled_on    date not null default current_date,
  method        text not null default 'venmo',
  note          text,
  created_by    uuid references profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  check (from_profile <> to_profile)
);

create index on settlements (household_id, settled_on desc);

-- ------------------------------------------------------- devices & activity

create table push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz
);

create index on push_subscriptions (profile_id);

-- The iPad on the wall. Authenticates with a bearer token instead of a user.
create table kiosk_devices (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  name          text not null,
  token_hash    text not null unique,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);

create table activity_log (
  id            bigserial primary key,
  household_id  uuid not null references households(id) on delete cascade,
  actor_id      uuid references profiles(id) on delete set null,
  verb          text not null,          -- 'completed_chore', 'added_expense', ...
  summary       text not null,          -- pre-rendered, for the kiosk feed
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index on activity_log (household_id, created_at desc);

-- ------------------------------------------------------------------- views

-- Net position per roommate. Positive => the household owes them money.
create view v_balances with (security_invoker = true) as
with paid as (
  select e.household_id, e.paid_by as profile_id, sum(e.amount_cents) as cents
  from expenses e where e.deleted_at is null
  group by 1, 2
),
owed as (
  select e.household_id, s.profile_id, sum(s.owed_cents) as cents
  from expense_splits s
  join expenses e on e.id = s.expense_id and e.deleted_at is null
  group by 1, 2
),
sent as (
  select household_id, from_profile as profile_id, sum(amount_cents) as cents
  from settlements group by 1, 2
),
received as (
  select household_id, to_profile as profile_id, sum(amount_cents) as cents
  from settlements group by 1, 2
)
select
  p.household_id,
  p.id as profile_id,
  coalesce(paid.cents, 0)
    - coalesce(owed.cents, 0)
    + coalesce(sent.cents, 0)
    - coalesce(received.cents, 0) as net_cents
from profiles p
left join paid     on paid.profile_id     = p.id and paid.household_id     = p.household_id
left join owed     on owed.profile_id     = p.id and owed.household_id     = p.household_id
left join sent     on sent.profile_id     = p.id and sent.household_id     = p.household_id
left join received on received.profile_id = p.id and received.household_id = p.household_id
where p.household_id is not null;

-- Running tally of completed turns per person per chore — the digital version
-- of counting crossed-out initials on the sheet.
create view v_chore_stats with (security_invoker = true) as
select
  t.household_id,
  t.chore_id,
  t.assignee_id as profile_id,
  count(*) filter (where t.status = 'done')    as done_count,
  count(*) filter (where t.status = 'missed')  as missed_count,
  max(t.completed_at)                          as last_done_at
from chore_turns t
group by 1, 2, 3;
