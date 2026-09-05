-- Three related tightenings to the rotation-management tools:
--
-- 1. Get-ahead/defer become per-chore, not just household-wide. An admin may
--    want e.g. "Trash to curb" (a hard deadline every driveway pickup)
--    excluded from deferring, while "Dishes" stays flexible. Both default to
--    true, matching the feature's own "on by default" household toggle.
--
-- 2. Standing chores no longer excluded from get-ahead/defer. Structurally
--    they only ever have one pending turn, so there's no separate "future
--    turn" already sitting there the way there is for scheduled/on_demand —
--    but find_or_create_next_turn_for's walk-forward branch already
--    materializes one on demand (a standing chore's next occurrence is
--    always immediately assigned to whoever's next in the fixed rotation,
--    same call already used for on_demand). The result is the same swap as
--    every other cadence: briefly two turns are pending for this chore at
--    once (the swapped-in one and the swapped-out one), which resolves back
--    to standing's usual single pending turn as each one is completed —
--    exactly "reshuffling the queue," the same as the other two cadences.
--
-- 3. pass_turn/skip_turn on someone else's turn now requires the actor to
--    be a household admin, not just allow_member_cross_complete — passing
--    or skipping affects someone else's rotation credit/fairness in a way
--    completing a chore for them doesn't, so it gets a stricter gate.
--    Acting on your *own* turn is unaffected either way.

alter table chores
  add column if not exists allow_get_ahead boolean not null default true,
  add column if not exists allow_defer     boolean not null default true;

/* ------------------------------------------------------------ chore admin */

drop function if exists create_chore(text, chore_cadence, text, text, smallint[], smallint, smallint, smallint, smallint, uuid[]);

create or replace function create_chore(
  p_name            text,
  p_cadence         chore_cadence,
  p_emoji           text default '🧹',
  p_description     text default null,
  p_days_of_week    smallint[] default '{}',
  p_interval_weeks  smallint default 1,
  p_due_hour        smallint default 20,
  p_queue_depth     smallint default 4,
  p_lookahead_days  smallint default 21,
  p_profile_ids     uuid[] default '{}',
  p_allow_get_ahead boolean default true,
  p_allow_defer     boolean default true
)
returns chores
language plpgsql
security definer
set search_path = public
as $$
declare
  hh        uuid;
  next_sort smallint;
  new_chore chores%rowtype;
begin
  if not is_household_admin() then raise exception 'only an admin can add a chore'; end if;
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'give it a name'; end if;

  select coalesce(max(sort_order), 0) + 1 into next_sort from chores where household_id = hh;

  insert into chores (
    household_id, name, emoji, description, cadence,
    days_of_week, interval_weeks, due_hour, queue_depth, lookahead_days, sort_order,
    allow_get_ahead, allow_defer
  )
  values (
    hh, trim(p_name), coalesce(nullif(trim(p_emoji), ''), '🧹'),
    nullif(trim(coalesce(p_description, '')), ''), p_cadence,
    coalesce(p_days_of_week, '{}'), greatest(coalesce(p_interval_weeks, 1), 1),
    coalesce(p_due_hour, 20), greatest(coalesce(p_queue_depth, 4), 1),
    greatest(coalesce(p_lookahead_days, 21), 1), next_sort,
    coalesce(p_allow_get_ahead, true), coalesce(p_allow_defer, true)
  )
  returning * into new_chore;

  if p_profile_ids is not null and array_length(p_profile_ids, 1) is not null then
    insert into chore_rotation (chore_id, profile_id, position)
    select new_chore.id, t.pid, t.ord - 1
    from unnest(p_profile_ids) with ordinality as t(pid, ord)
    where exists (select 1 from profiles where id = t.pid and household_id = hh);
  end if;

  if new_chore.cadence = 'scheduled' then
    perform materialize_schedule(new_chore.id);
  else
    perform top_up_queue(new_chore.id);
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (hh, auth.uid(), 'created_chore', new_chore.name || ' was added to the board',
          jsonb_build_object('chore_id', new_chore.id, 'emoji', new_chore.emoji));

  return new_chore;
end;
$$;

drop function if exists update_chore(uuid, text, text, text, chore_cadence, smallint[], smallint, smallint, smallint, smallint, smallint);

create or replace function update_chore(
  p_chore           uuid,
  p_name            text default null,
  p_emoji           text default null,
  p_description     text default null,
  p_cadence         chore_cadence default null,
  p_days_of_week    smallint[] default null,
  p_interval_weeks  smallint default null,
  p_due_hour        smallint default null,
  p_queue_depth     smallint default null,
  p_lookahead_days  smallint default null,
  p_sort_order      smallint default null,
  p_allow_get_ahead boolean default null,
  p_allow_defer     boolean default null
)
returns chores
language plpgsql
security definer
set search_path = public
as $$
declare
  hh              uuid;
  before          chores%rowtype;
  after           chores%rowtype;
  cadence_changed boolean;
begin
  if not is_household_admin() then raise exception 'only an admin can edit a chore'; end if;
  select household_id into hh from profiles where id = auth.uid();

  select * into before from chores where id = p_chore and household_id = hh;
  if not found then raise exception 'that chore is not in your household'; end if;

  update chores set
    name             = coalesce(nullif(trim(p_name), ''), name),
    emoji            = coalesce(nullif(trim(p_emoji), ''), emoji),
    description      = case when p_description is not null
                            then nullif(trim(p_description), '') else description end,
    cadence          = coalesce(p_cadence, cadence),
    days_of_week     = coalesce(p_days_of_week, days_of_week),
    interval_weeks   = coalesce(p_interval_weeks, interval_weeks),
    due_hour         = coalesce(p_due_hour, due_hour),
    queue_depth      = coalesce(p_queue_depth, queue_depth),
    lookahead_days   = coalesce(p_lookahead_days, lookahead_days),
    sort_order       = coalesce(p_sort_order, sort_order),
    allow_get_ahead  = coalesce(p_allow_get_ahead, allow_get_ahead),
    allow_defer      = coalesce(p_allow_defer, allow_defer)
  where id = p_chore
  returning * into after;

  cadence_changed :=
    after.cadence        is distinct from before.cadence or
    after.days_of_week   is distinct from before.days_of_week or
    after.interval_weeks is distinct from before.interval_weeks or
    after.due_hour       is distinct from before.due_hour or
    after.queue_depth    is distinct from before.queue_depth;

  if cadence_changed then
    delete from chore_turns where chore_id = p_chore and status = 'pending';
    if after.cadence = 'scheduled' then
      perform materialize_schedule(p_chore);
    else
      perform top_up_queue(p_chore);
    end if;
  end if;

  return after;
end;
$$;

/* ---------------------------------------------------------- get_ahead/defer */

create or replace function get_ahead(p_chore uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  me             uuid := auth.uid();
  c              chores%rowtype;
  current_turn   chore_turns%rowtype;
  my_turn        chore_turns%rowtype;
  current_holder uuid;
  mod_enabled    boolean;
  mod_settings   jsonb;
  max_per_30d    int;
  uses_30d       int;
begin
  select * into c from chores where id = p_chore;
  if not found then raise exception 'chore not found'; end if;
  if not is_household_member(c.household_id) then raise exception 'not your household'; end if;
  if not c.allow_get_ahead then
    raise exception 'get-ahead is turned off for this chore';
  end if;
  if not exists (select 1 from chore_rotation where chore_id = p_chore and profile_id = me) then
    raise exception 'you are not in this chore''s rotation';
  end if;

  select enabled, settings into mod_enabled, mod_settings
    from household_modules where household_id = c.household_id and module = 'get_ahead';
  if not coalesce(mod_enabled, true) then raise exception 'get-ahead is turned off for this house'; end if;
  max_per_30d := coalesce((coalesce(mod_settings, '{}'::jsonb) #>> '{get_ahead,max_per_30d}')::int, 1);

  select * into current_turn from chore_turns
   where chore_id = p_chore and status = 'pending'
   order by turn_number limit 1;
  if not found then raise exception 'nothing pending on this chore'; end if;

  current_holder := current_turn.assignee_id;
  if current_holder = me then
    raise exception 'it is already your turn';
  end if;

  select count(*) into uses_30d from chore_advance_log
   where chore_id = p_chore and profile_id = me and kind = 'get_ahead'
     and created_at > now() - interval '30 days';
  if uses_30d >= max_per_30d then
    raise exception 'You have used get-ahead % time(s) in the last 30 days — the house limit is %.', uses_30d, max_per_30d;
  end if;

  my_turn := find_or_create_next_turn_for(p_chore, me, current_turn.turn_number);

  update chore_turns set assignee_id = me where id = current_turn.id;
  update chore_turns set assignee_id = current_holder where id = my_turn.id;

  insert into chore_advance_log (chore_id, profile_id, kind, turn_id)
  values (p_chore, me, 'get_ahead', current_turn.id);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select c.household_id, me, 'got_ahead', p.full_name || ' got ahead on ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', current_turn.id, 'emoji', c.emoji)
  from profiles p where p.id = me;

  select * into current_turn from chore_turns where id = current_turn.id;
  return current_turn;
end;
$$;

create or replace function defer_turn(p_turn uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  me           uuid := auth.uid();
  t            chore_turns%rowtype;
  c            chores%rowtype;
  next_person  uuid;
  other_turn   chore_turns%rowtype;
  n            int;
  cur_pos      int;
  cand         uuid;
  mod_enabled  boolean;
  mod_settings jsonb;
  max_per_30d  int;
  uses_30d     int;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then raise exception 'turn not found'; end if;
  if not is_household_member(t.household_id) then raise exception 'not your household'; end if;
  if t.status <> 'pending' then raise exception 'that turn is not pending'; end if;
  if me is distinct from t.assignee_id then raise exception 'you can only defer your own turn'; end if;

  select * into c from chores where id = t.chore_id;
  if not c.allow_defer then
    raise exception 'defer is turned off for this chore';
  end if;

  select enabled, settings into mod_enabled, mod_settings
    from household_modules where household_id = c.household_id and module = 'get_ahead';
  if not coalesce(mod_enabled, true) then raise exception 'get-ahead/defer is turned off for this house'; end if;
  max_per_30d := coalesce((coalesce(mod_settings, '{}'::jsonb) #>> '{defer,max_per_30d}')::int, 1);

  select count(*) into uses_30d from chore_advance_log
   where chore_id = t.chore_id and profile_id = me and kind = 'defer'
     and created_at > now() - interval '30 days';
  if uses_30d >= max_per_30d then
    raise exception 'You have deferred % time(s) in the last 30 days — the house limit is %.', uses_30d, max_per_30d;
  end if;

  select count(*) into n from chore_rotation where chore_id = t.chore_id;
  if n <= 1 then raise exception 'no one else in the rotation to defer to'; end if;

  select position into cur_pos from chore_rotation where chore_id = t.chore_id and profile_id = me;
  if cur_pos is null then raise exception 'you are not in this chore''s rotation'; end if;

  next_person := null;
  for i in 1..n - 1 loop
    select profile_id into cand from chore_rotation
     where chore_id = t.chore_id and position = (cur_pos + i) % n;
    if not is_away_at(cand, coalesce(t.due_at, now())) then
      next_person := cand;
      exit;
    end if;
  end loop;

  if next_person is null then
    raise exception 'everyone else is away — pass or skip instead';
  end if;

  other_turn := find_or_create_next_turn_for(t.chore_id, next_person, t.turn_number);

  update chore_turns set assignee_id = next_person where id = t.id;
  update chore_turns set assignee_id = me where id = other_turn.id;

  insert into chore_advance_log (chore_id, profile_id, kind, turn_id)
  values (t.chore_id, me, 'defer', p_turn);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me, 'deferred_chore', p.full_name || ' pushed back ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = me;

  select * into t from chore_turns where id = t.id;
  return t;
end;
$$;

/* ----------------------------------------------------- admin-only pass/skip */

-- Acting on your own turn is unaffected. Acting on someone else's now
-- requires being a household admin, replacing the allow_member_cross_complete
-- check that used to gate this the same as complete_turn — passing or
-- skipping affects someone else's rotation fairness, unlike completing a
-- chore for them.
create or replace function skip_turn(p_turn uuid, p_note text default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t chore_turns%rowtype;
  c chores%rowtype;
  me uuid := auth.uid();
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then
    raise exception 'turn not found';
  end if;
  if not is_household_member(t.household_id) then
    raise exception 'not your household';
  end if;
  if t.status <> 'pending' then
    raise exception 'that turn is not pending';
  end if;

  if me is distinct from t.assignee_id then
    if not is_household_admin() then
      raise exception 'only an admin can skip this for someone else';
    end if;
  end if;

  update chore_turns
     set status = 'skipped', completed_at = now(), completed_by = me, note = p_note
   where id = p_turn
  returning * into t;

  select * into c from chores where id = t.chore_id;

  if c.cadence = 'scheduled' then
    perform materialize_schedule(t.chore_id);
  else
    perform top_up_queue(t.chore_id);
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me,
         'skipped_chore',
         case when me is distinct from t.assignee_id
              then p.full_name || ' skipped ' || c.name || ' for ' || a.full_name
              else p.full_name || ' skipped ' || c.name
         end,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p
  join profiles a on a.id = t.assignee_id
  where p.id = coalesce(me, t.assignee_id);

  return t;
end;
$$;

create or replace function pass_turn(p_turn uuid, p_note text default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t          chore_turns%rowtype;
  c          chores%rowtype;
  me         uuid := auth.uid();
  n          int;
  cur_pos    int;
  at         timestamptz;
  next_id    uuid;
  cand       uuid;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then raise exception 'turn not found'; end if;
  if not is_household_member(t.household_id) then raise exception 'not your household'; end if;
  if t.status <> 'pending' then raise exception 'that turn is not pending'; end if;

  if me is distinct from t.assignee_id then
    if not is_household_admin() then
      raise exception 'only an admin can pass this for someone else';
    end if;
  end if;

  select count(*) into n from chore_rotation where chore_id = t.chore_id;
  if n <= 1 then
    raise exception 'no one else in the rotation to pass to';
  end if;

  select position into cur_pos from chore_rotation
   where chore_id = t.chore_id and profile_id = t.assignee_id;
  at := coalesce(t.due_at, now());

  if cur_pos is not null then
    for i in 1..n - 1 loop
      select profile_id into cand
      from chore_rotation
      where chore_id = t.chore_id and position = (cur_pos + i) % n;
      if not is_away_at(cand, at) then
        next_id := cand;
        exit;
      end if;
    end loop;
  end if;

  if next_id is null then
    raise exception 'everyone else is away — skip the task instead';
  end if;

  update chore_turns
     set assignee_id = next_id, note = coalesce(p_note, note)
   where id = p_turn
   returning * into t;

  select * into c from chores where id = t.chore_id;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me, 'passed_chore',
         p.full_name || ' passed ' || c.name || ' to ' || nx.full_name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p, profiles nx
  where p.id = coalesce(me, t.assignee_id) and nx.id = next_id;

  return t;
end;
$$;
