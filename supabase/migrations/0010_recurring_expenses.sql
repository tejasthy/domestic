-- Rent, subscriptions, and other bills that repeat on a schedule and should
-- just show up in the ledger without anyone remembering to add them.
--
-- Splits are computed once, in TypeScript, using the same splitEqual /
-- splitByWeight helpers addExpense already uses for one-off expenses — the
-- resulting owed_cents (and weight, kept for re-editing exactly like
-- expense_splits.weight) are stored per participant. Posting a due occurrence
-- is then a pure copy, not a re-derivation, so there is no separate plpgsql
-- port of the splitting math to keep in sync with money.ts.
--
-- Management (create/edit/pause) follows the household_invites /
-- kiosk_devices / chores shape: the tables carry only a SELECT policy, and
-- every write goes through a SECURITY DEFINER function that checks
-- is_household_admin(). A recurring expense is standing configuration that
-- re-fires forever with no per-occurrence confirmation, unlike a one-off
-- expense that is reviewed once at creation — that risk profile matches the
-- admin-gated tier, not the member-writable tier expenses/settlements sit in.
--
-- Posting itself (post_due_recurring_expenses) is different in kind: it runs
-- with no user session, invoked by cron via the admin client exactly like
-- materialize_schedule/top_up_queue, must be all-or-nothing per occurrence,
-- and must be safe to call twice a day — the "atomic, cron-invoked" category
-- CLAUDE.md calls out for plpgsql, same as its chores counterparts.

create table if not exists recurring_expenses (
  id               uuid primary key default gen_random_uuid(),
  household_id     uuid not null references households(id) on delete cascade,
  description      text not null,
  amount_cents     bigint not null check (amount_cents > 0),
  currency         char(3) not null default 'USD',
  category         text not null default 'general',
  paid_by          uuid not null references profiles(id) on delete restrict,
  split_kind       split_kind not null default 'equal',

  -- Two cadence families, each with a multiplier: weekly x1 = weekly, x2 =
  -- biweekly; monthly x1 = monthly, x3 = quarterly. day_of_month is clamped to
  -- the last day of short months when posting.
  cadence          text not null check (cadence in ('weekly', 'monthly')),
  interval_weeks   smallint not null default 1 check (interval_weeks > 0),
  interval_months  smallint not null default 1 check (interval_months > 0),
  day_of_month     smallint check (day_of_month between 1 and 31),
  check (cadence = 'weekly' or day_of_month is not null),

  next_run_on      date not null default current_date,
  is_active        boolean not null default true,
  created_by       uuid references profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);

create index if not exists recurring_expenses_household_id_is_active_idx
  on recurring_expenses (household_id, is_active);

create table if not exists recurring_expense_participants (
  recurring_expense_id uuid   not null references recurring_expenses(id) on delete cascade,
  profile_id            uuid   not null references profiles(id) on delete cascade,
  owed_cents            bigint not null check (owed_cents >= 0),
  weight                numeric(10,4),
  primary key (recurring_expense_id, profile_id)
);

/* --------------------------------------------------------------- management */

create or replace function create_recurring_expense(
  p_description     text,
  p_amount_cents    bigint,
  p_paid_by         uuid,
  p_split_kind      split_kind,
  p_cadence         text,
  p_participants    jsonb,  -- [{"profile_id": uuid, "owed_cents": int, "weight": numeric|null}, ...]
  p_category        text default 'general',
  p_interval_weeks  smallint default 1,
  p_interval_months smallint default 1,
  p_day_of_month    smallint default null,
  p_start_on        date default current_date
)
returns recurring_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  hh      uuid;
  total   bigint;
  row_out recurring_expenses%rowtype;
begin
  if not is_household_admin() then raise exception 'only an admin can add a recurring expense'; end if;
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  if p_cadence not in ('weekly', 'monthly') then raise exception 'unknown cadence %', p_cadence; end if;
  if p_cadence = 'monthly' and p_day_of_month is null then
    raise exception 'a monthly recurring expense needs a day of the month';
  end if;
  if not exists (select 1 from profiles where id = p_paid_by and household_id = hh) then
    raise exception 'the payer must be in your household';
  end if;
  if jsonb_array_length(coalesce(p_participants, '[]'::jsonb)) = 0 then
    raise exception 'split it with someone';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_participants) as x(profile_id uuid, owed_cents bigint, weight numeric)
    where not exists (select 1 from profiles where id = x.profile_id and household_id = hh)
  ) then
    raise exception 'everyone in the split must be in your household';
  end if;

  select sum(x.owed_cents) into total
  from jsonb_to_recordset(p_participants) as x(profile_id uuid, owed_cents bigint, weight numeric);
  if total is distinct from p_amount_cents then
    raise exception 'splits must add up to the total';
  end if;

  insert into recurring_expenses (
    household_id, description, amount_cents, category, paid_by, split_kind,
    cadence, interval_weeks, interval_months, day_of_month, next_run_on, created_by
  )
  values (
    hh, trim(p_description), p_amount_cents, coalesce(p_category, 'general'), p_paid_by, p_split_kind,
    p_cadence, greatest(coalesce(p_interval_weeks, 1), 1), greatest(coalesce(p_interval_months, 1), 1),
    p_day_of_month, coalesce(p_start_on, current_date), auth.uid()
  )
  returning * into row_out;

  insert into recurring_expense_participants (recurring_expense_id, profile_id, owed_cents, weight)
  select row_out.id, x.profile_id, x.owed_cents, x.weight
  from jsonb_to_recordset(p_participants) as x(profile_id uuid, owed_cents bigint, weight numeric);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (hh, auth.uid(), 'created_recurring_expense',
          row_out.description || ' will repeat ' || row_out.cadence,
          jsonb_build_object('recurring_expense_id', row_out.id));

  return row_out;
end;
$$;

create or replace function update_recurring_expense(
  p_id              uuid,
  p_description     text default null,
  p_amount_cents    bigint default null,
  p_paid_by         uuid default null,
  p_split_kind      split_kind default null,
  p_category        text default null,
  p_cadence         text default null,
  p_interval_weeks  smallint default null,
  p_interval_months smallint default null,
  p_day_of_month    smallint default null,
  p_participants    jsonb default null
)
returns recurring_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  hh         uuid;
  before     recurring_expenses%rowtype;
  row_out    recurring_expenses%rowtype;
  total      bigint;
  new_amount bigint;
begin
  if not is_household_admin() then raise exception 'only an admin can edit a recurring expense'; end if;
  select household_id into hh from profiles where id = auth.uid();

  select * into before from recurring_expenses where id = p_id and household_id = hh;
  if not found then raise exception 'that recurring expense is not in your household'; end if;

  if p_cadence is not null and p_cadence not in ('weekly', 'monthly') then
    raise exception 'unknown cadence %', p_cadence;
  end if;
  if coalesce(p_cadence, before.cadence) = 'monthly'
     and coalesce(p_day_of_month, before.day_of_month) is null then
    raise exception 'a monthly recurring expense needs a day of the month';
  end if;
  if p_paid_by is not null and not exists (select 1 from profiles where id = p_paid_by and household_id = hh) then
    raise exception 'the payer must be in your household';
  end if;

  new_amount := coalesce(p_amount_cents, before.amount_cents);

  if p_participants is not null then
    if exists (
      select 1 from jsonb_to_recordset(p_participants) as x(profile_id uuid, owed_cents bigint, weight numeric)
      where not exists (select 1 from profiles where id = x.profile_id and household_id = hh)
    ) then
      raise exception 'everyone in the split must be in your household';
    end if;
    select sum(x.owed_cents) into total
    from jsonb_to_recordset(p_participants) as x(profile_id uuid, owed_cents bigint, weight numeric);
    if total is distinct from new_amount then
      raise exception 'splits must add up to the total';
    end if;
  end if;

  update recurring_expenses set
    description     = coalesce(nullif(trim(p_description), ''), description),
    amount_cents    = new_amount,
    paid_by         = coalesce(p_paid_by, paid_by),
    split_kind      = coalesce(p_split_kind, split_kind),
    category        = coalesce(p_category, category),
    cadence         = coalesce(p_cadence, cadence),
    interval_weeks  = coalesce(p_interval_weeks, interval_weeks),
    interval_months = coalesce(p_interval_months, interval_months),
    day_of_month    = coalesce(p_day_of_month, day_of_month)
  where id = p_id
  returning * into row_out;

  if p_participants is not null then
    delete from recurring_expense_participants where recurring_expense_id = p_id;
    insert into recurring_expense_participants (recurring_expense_id, profile_id, owed_cents, weight)
    select p_id, x.profile_id, x.owed_cents, x.weight
    from jsonb_to_recordset(p_participants) as x(profile_id uuid, owed_cents bigint, weight numeric);
  end if;

  return row_out;
end;
$$;

create or replace function set_recurring_expense_active(p_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare hh uuid;
begin
  if not is_household_admin() then raise exception 'only an admin can do that'; end if;
  select household_id into hh from profiles where id = auth.uid();
  update recurring_expenses set is_active = p_active where id = p_id and household_id = hh;
  if not found then raise exception 'that recurring expense is not in your household'; end if;
end;
$$;

/* ------------------------------------------------------------------ posting */

-- Catches up on any missed cycles (server downtime, a skipped cron run) one
-- occurrence at a time, capped so a bug can never spin this into a runaway
-- loop. Idempotent across the twice-daily cron: next_run_on is advanced past
-- `today` inside the same statement that inserts the expense, so a second run
-- later that day sees next_run_on > today and does nothing for that row.
create or replace function post_due_recurring_expenses()
returns setof expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  r           recurring_expenses%rowtype;
  tz          text;
  today       date;
  new_expense expenses%rowtype;
  next_date   date;
  guard       int;
begin
  for r in select * from recurring_expenses where is_active for update loop
    select timezone into tz from households where id = r.household_id;
    today := (now() at time zone coalesce(tz, 'America/Detroit'))::date;
    guard := 0;

    while r.next_run_on <= today and guard < 24 loop
      insert into expenses (
        household_id, description, amount_cents, currency, category,
        paid_by, spent_on, split_kind, created_by, note
      )
      values (
        r.household_id, r.description, r.amount_cents, r.currency, r.category,
        r.paid_by, r.next_run_on, r.split_kind, r.created_by, 'Recurring'
      )
      returning * into new_expense;

      insert into expense_splits (expense_id, profile_id, owed_cents, weight)
      select new_expense.id, p.profile_id, p.owed_cents, p.weight
      from recurring_expense_participants p
      where p.recurring_expense_id = r.id;

      insert into activity_log (household_id, actor_id, verb, summary, metadata)
      values (r.household_id, r.created_by, 'added_expense',
              r.description || ' — ' || to_char(r.amount_cents / 100.0, 'FM$999999990.00') || ' (recurring)',
              jsonb_build_object('expense_id', new_expense.id, 'recurring_expense_id', r.id));

      if r.cadence = 'weekly' then
        next_date := r.next_run_on + (r.interval_weeks * 7);
      else
        next_date := (date_trunc('month', r.next_run_on) + (r.interval_months || ' months')::interval)::date;
        next_date := next_date + (
          least(r.day_of_month, extract(day from (next_date + interval '1 month - 1 day'))::int) - 1
        );
      end if;
      r.next_run_on := next_date;
      update recurring_expenses set next_run_on = next_date where id = r.id;

      return next new_expense;
      guard := guard + 1;
    end loop;
  end loop;
  return;
end;
$$;

/* --------------------------------------------------------------------- RLS */

alter table recurring_expenses enable row level security;
alter table recurring_expense_participants enable row level security;

drop policy if exists rec_exp_read on recurring_expenses;
create policy rec_exp_read on recurring_expenses for select
  using (is_household_member(household_id));

drop policy if exists rec_part_read on recurring_expense_participants;
create policy rec_part_read on recurring_expense_participants for select
  using (exists (
    select 1 from recurring_expenses r
    where r.id = recurring_expense_id and is_household_member(r.household_id)
  ));
