-- Rotation engine + row level security.

-- --------------------------------------------------------------- helpers

-- SECURITY DEFINER so RLS policies can call it without recursing into
-- the profiles policy that is itself being evaluated.
create or replace function current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from profiles where id = auth.uid();
$$;

create or replace function is_household_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target is not null and target = (
    select household_id from profiles where id = auth.uid()
  );
$$;

-- New auth user -> profile. Metadata is set at invite time.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, full_name, initials, household_id)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'initials', upper(left(coalesce(new.raw_user_meta_data ->> 'full_name', new.email), 2))),
    (new.raw_user_meta_data ->> 'household_id')::uuid
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ------------------------------------------------------- rotation engine

-- Who owns turn N of a chore?
create or replace function rotation_assignee(p_chore uuid, p_turn integer)
returns uuid
language plpgsql
stable
as $$
declare
  n int;
  who uuid;
begin
  select count(*) into n from chore_rotation where chore_rotation.chore_id = p_chore;
  if n = 0 then
    return null;
  end if;
  select profile_id into who
  from chore_rotation
  where chore_rotation.chore_id = p_chore
    and chore_rotation.position = (p_turn % n)
  limit 1;
  return who;
end;
$$;

-- Append the next turn in the cycle. Returns the new turn, or null if the
-- chore has no rotation configured.
create or replace function append_turn(p_chore uuid, p_due timestamptz default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  next_no  int;
  who      uuid;
  hh       uuid;
  new_turn chore_turns;
begin
  select household_id into hh from chores where id = p_chore;
  select coalesce(max(turn_number), -1) + 1 into next_no
    from chore_turns where chore_id = p_chore;

  who := rotation_assignee(p_chore, next_no);
  if who is null then
    return null;
  end if;

  insert into chore_turns (chore_id, household_id, turn_number, assignee_id, due_at)
  values (p_chore, hh, next_no, who, p_due)
  returning * into new_turn;

  return new_turn;
end;
$$;

-- Keep `queue_depth` pending turns available for an on-demand chore, so the
-- kiosk can always show "up next" the way the numbered rows on the sheet do.
create or replace function top_up_queue(p_chore uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  want    int;
  have    int;
  made    int := 0;
begin
  select queue_depth into want from chores where id = p_chore and cadence = 'on_demand';
  if want is null then
    return 0;
  end if;

  select count(*) into have
    from chore_turns where chore_id = p_chore and status = 'pending';

  while have + made < want loop
    perform append_turn(p_chore, null);
    made := made + 1;
  end loop;

  return made;
end;
$$;

-- Materialize scheduled turns out to the chore's lookahead window.
-- A week is "on" when its offset from the anchor week is a multiple of
-- interval_weeks -- that is how "biweekly on weekends" stays in phase.
create or replace function materialize_schedule(p_chore uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c        chores%rowtype;
  tz       text;
  cursor_d date;
  last_d   date;
  horizon  date;
  made     int := 0;
  wk_off   int;
  anchor_w date;
begin
  select * into c from chores where id = p_chore and cadence = 'scheduled' and is_active;
  if not found or array_length(c.days_of_week, 1) is null then
    return 0;
  end if;

  select timezone into tz from households where id = c.household_id;
  horizon  := (now() at time zone tz)::date + c.lookahead_days;
  anchor_w := date_trunc('week', c.anchor_date)::date;   -- Monday-based

  -- resume after the furthest turn we already created
  select max((due_at at time zone tz)::date) into last_d
    from chore_turns where chore_id = p_chore;

  cursor_d := greatest(
    coalesce(last_d + 1, c.anchor_date),
    (now() at time zone tz)::date
  );

  while cursor_d <= horizon loop
    wk_off := ((date_trunc('week', cursor_d)::date - anchor_w) / 7)::int;
    if (extract(dow from cursor_d)::smallint = any (c.days_of_week))
       and (wk_off % greatest(c.interval_weeks, 1) = 0) then
      perform append_turn(
        p_chore,
        ((cursor_d + make_interval(hours => c.due_hour)) at time zone tz)
      );
      made := made + 1;
    end if;
    cursor_d := cursor_d + 1;
  end loop;

  return made;
end;
$$;

-- Complete a turn and immediately open the next one, so there is never a
-- moment where nobody is "up".
create or replace function complete_turn(p_turn uuid, p_note text default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t   chore_turns%rowtype;
  c   chores%rowtype;
  me  uuid := auth.uid();
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then
    raise exception 'turn not found';
  end if;
  if not is_household_member(t.household_id) then
    raise exception 'not your household';
  end if;
  if t.status = 'done' then
    return t;
  end if;

  update chore_turns
     set status = 'done', completed_at = now(), completed_by = coalesce(me, t.assignee_id), note = p_note
   where id = p_turn
  returning * into t;

  select * into c from chores where id = t.chore_id;

  if c.cadence = 'on_demand' then
    perform top_up_queue(t.chore_id);
  else
    perform materialize_schedule(t.chore_id);
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, coalesce(me, t.assignee_id), 'completed_chore',
         p.full_name || ' did ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = coalesce(me, t.assignee_id);

  return t;
end;
$$;

-- Called by the "dishwasher is full" / "trash is full" buttons: nothing to
-- create (the queue is already primed) but it timestamps the request and
-- pings whoever is up.
create or replace function flag_on_demand(p_chore uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t chore_turns%rowtype;
  c chores%rowtype;
begin
  select * into c from chores where id = p_chore;
  if not is_household_member(c.household_id) then
    raise exception 'not your household';
  end if;

  perform top_up_queue(p_chore);

  select * into t from chore_turns
   where chore_id = p_chore and status = 'pending'
   order by turn_number limit 1;

  update chore_turns set due_at = now() where id = t.id and due_at is null;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select c.household_id, auth.uid(), 'flagged_chore',
         c.name || ' needs doing',
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji);

  return t;
end;
$$;

-- Accepting a swap just reassigns the turn; the rotation itself is untouched,
-- so the cycle stays in order for everyone after.
create or replace function accept_swap(p_swap uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s chore_swaps%rowtype;
begin
  select * into s from chore_swaps where id = p_swap for update;
  if not found or s.status <> 'pending' then
    raise exception 'swap not open';
  end if;
  if s.requested_to <> auth.uid() then
    raise exception 'not your swap to accept';
  end if;

  update chore_turns set assignee_id = s.requested_to where id = s.turn_id;
  update chore_swaps set status = 'accepted', resolved_at = now() where id = p_swap;
end;
$$;

-- ------------------------------------------------------------------- RLS

alter table households        enable row level security;
alter table profiles          enable row level security;
alter table chores            enable row level security;
alter table chore_rotation    enable row level security;
alter table chore_turns       enable row level security;
alter table chore_swaps       enable row level security;
alter table expenses          enable row level security;
alter table expense_splits    enable row level security;
alter table settlements       enable row level security;
alter table push_subscriptions enable row level security;
alter table kiosk_devices     enable row level security;
alter table activity_log      enable row level security;

create policy hh_read on households for select
  using (id = current_household_id());

create policy pr_read on profiles for select
  using (household_id = current_household_id() or id = auth.uid());
create policy pr_write on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

create policy ch_all on chores for all
  using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy rot_all on chore_rotation for all
  using (exists (select 1 from chores c where c.id = chore_id and is_household_member(c.household_id)))
  with check (exists (select 1 from chores c where c.id = chore_id and is_household_member(c.household_id)));

create policy turn_all on chore_turns for all
  using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy swap_all on chore_swaps for all
  using (exists (select 1 from chore_turns t where t.id = turn_id and is_household_member(t.household_id)))
  with check (exists (select 1 from chore_turns t where t.id = turn_id and is_household_member(t.household_id)));

create policy exp_all on expenses for all
  using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy split_all on expense_splits for all
  using (exists (select 1 from expenses e where e.id = expense_id and is_household_member(e.household_id)))
  with check (exists (select 1 from expenses e where e.id = expense_id and is_household_member(e.household_id)));

create policy settle_all on settlements for all
  using (is_household_member(household_id))
  with check (is_household_member(household_id));

create policy push_own on push_subscriptions for all
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

create policy kiosk_read on kiosk_devices for select
  using (is_household_member(household_id));

create policy act_read on activity_log for select
  using (is_household_member(household_id));
create policy act_insert on activity_log for insert
  with check (is_household_member(household_id));

-- Views are created with security_invoker = true in 0001 so they honour the
-- caller's RLS rather than the view owner's.
