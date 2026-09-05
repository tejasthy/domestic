-- A third cadence: `standing`. Some chores aren't naturally "on a schedule"
-- or "a queue you flag when it's full" — they're just always somebody's job
-- until they hand it off (take out recycling, restock TP). A standing chore
-- has exactly one pending turn at a time, no due date, and is always visible
-- in the to-do list without needing a flag. Completing it is an instant
-- baton-pass: the next person's turn opens immediately.
--
-- This is implemented as on_demand's queue model with queue_depth pinned to
-- 1 — no new turn-creation machinery, just top_up_queue generalized to know
-- about it.
--
-- `alter type ... add value` must not run in the same transaction as its
-- first use. This file has no explicit BEGIN, so each top-level statement
-- here autocommits on its own (same as 0001's original enum creation), which
-- is why the enum is extended first and used starting with the next
-- statement.

alter type chore_cadence add value if not exists 'standing';

/* ---------------------------------------------------------- top_up_queue */

-- on_demand keeps `queue_depth` turns pending; standing always wants exactly
-- one (the "current" turn) and ignores queue_depth entirely; scheduled chores
-- go through materialize_schedule instead, same as before.
create or replace function top_up_queue(p_chore uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cad      chore_cadence;
  want     int;
  have     int;
  made     int := 0;
  new_turn chore_turns;
begin
  select cadence into cad from chores where id = p_chore;

  if cad = 'on_demand' then
    select queue_depth into want from chores where id = p_chore;
  elsif cad = 'standing' then
    want := 1;
  else
    return 0;
  end if;

  select count(*) into have
    from chore_turns where chore_id = p_chore and status = 'pending';

  while have + made < want loop
    new_turn := append_turn(p_chore, null);
    exit when new_turn.id is null;
    made := made + 1;
  end loop;

  return made;
end;
$$;

/* ------------------------------------------------ cadence-branch fix-ups */

-- complete_turn / kiosk_complete_turn / skip_turn all branched
-- `if cadence = 'on_demand' then top_up_queue else materialize_schedule` —
-- a standing chore fell into the `else` and hit materialize_schedule, which
-- silently no-ops on anything but `scheduled` (its own guard). Net effect
-- without this fix: a standing chore's queue would never refill past the
-- first completion. Flip the branch so scheduled is the special case.

create or replace function complete_turn(p_turn uuid, p_note text default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t           chore_turns%rowtype;
  c           chores%rowtype;
  me          uuid := auth.uid();
  allow_cross boolean;
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

  if me is distinct from t.assignee_id then
    select allow_member_cross_complete into allow_cross
    from households where id = t.household_id;
    if not coalesce(allow_cross, false) then
      raise exception 'only the assigned member can complete this — an admin can let anyone complete anyone''s chores in Settings';
    end if;
  end if;

  update chore_turns
     set status = 'done', completed_at = now(), completed_by = coalesce(me, t.assignee_id), note = p_note
   where id = p_turn
  returning * into t;

  select * into c from chores where id = t.chore_id;

  if c.cadence = 'scheduled' then
    perform materialize_schedule(t.chore_id);
  else
    perform top_up_queue(t.chore_id);
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, coalesce(me, t.assignee_id), 'completed_chore',
         p.full_name || ' did ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = coalesce(me, t.assignee_id);

  return t;
end;
$$;

create or replace function kiosk_complete_turn(
  p_household uuid,
  p_turn      uuid,
  p_profile   uuid,
  p_note      text default null
)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t chore_turns%rowtype;
  c chores%rowtype;
begin
  if not exists (select 1 from profiles where id = p_profile and household_id = p_household) then
    raise exception 'not a member of this household';
  end if;

  select * into t from chore_turns where id = p_turn and household_id = p_household for update;
  if not found then raise exception 'turn not found'; end if;
  if t.status = 'done' then return t; end if;

  update chore_turns
     set status = 'done', completed_at = now(), completed_by = p_profile, note = p_note
   where id = p_turn
  returning * into t;

  select * into c from chores where id = t.chore_id;

  if c.cadence = 'scheduled' then
    perform materialize_schedule(t.chore_id);
  else
    perform top_up_queue(t.chore_id);
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, p_profile, 'completed_chore',
         p.full_name || ' did ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = p_profile;

  return t;
end;
$$;

create or replace function skip_turn(p_turn uuid, p_note text default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t           chore_turns%rowtype;
  c           chores%rowtype;
  me          uuid := auth.uid();
  allow_cross boolean;
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
    select allow_member_cross_complete into allow_cross
    from households where id = t.household_id;
    if not coalesce(allow_cross, false) then
      raise exception 'only the assigned member can skip this — an admin can let anyone act for anyone in Settings';
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

-- set_away/clear_away only topped up on_demand chores after resyncing —
-- standing chores need the same top-up (they are, in effect, a queue of
-- depth 1) or a standing chore could sit with zero pending turns after
-- everyone's away status changes.
create or replace function set_away(p_until timestamptz default null)
returns member_away
language plpgsql
security definer
set search_path = public
as $$
declare
  me   uuid := auth.uid();
  hh   uuid;
  name text;
  row  member_away%rowtype;
  c    record;
begin
  select household_id, full_name into hh, name from profiles where id = me;
  if hh is null then raise exception 'you are not in a household'; end if;

  update member_away
     set ends_at = now()
   where profile_id = me
     and starts_at <= now()
     and (ends_at is null or now() < ends_at);

  insert into member_away (profile_id, household_id, ends_at)
  values (me, hh, p_until)
  returning * into row;

  for c in select id, cadence from chores where household_id = hh and is_active loop
    perform resync_pending_turns(c.id);
    if c.cadence <> 'scheduled' then
      perform top_up_queue(c.id);
    end if;
  end loop;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (hh, me, 'set_away',
          name || ' is away' || case when p_until is not null
            then ' until ' || to_char(p_until, 'Mon DD') else '' end,
          jsonb_build_object('until', p_until));

  return row;
end;
$$;

create or replace function clear_away()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me   uuid := auth.uid();
  hh   uuid;
  name text;
  c    record;
begin
  select household_id, full_name into hh, name from profiles where id = me;
  if hh is null then raise exception 'you are not in a household'; end if;

  update member_away
     set ends_at = now()
   where profile_id = me
     and starts_at <= now()
     and (ends_at is null or now() < ends_at);

  for c in select id, cadence from chores where household_id = hh and is_active loop
    perform resync_pending_turns(c.id);
    if c.cadence <> 'scheduled' then
      perform top_up_queue(c.id);
    end if;
  end loop;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (hh, me, 'cleared_away', name || ' is back', '{}'::jsonb);
end;
$$;

/* ---------------------------------------------------------------- undo */

-- Reopening a done/skipped STANDING turn must not leave two pending turns
-- alive at once — top_up_queue already created the next one the moment this
-- turn resolved. That next turn is not real history (it was never done or
-- skipped), so deleting it before reopening the original is safe and keeps
-- "exactly one pending turn" true for standing chores.
create or replace function undo_turn(p_turn uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t           chore_turns%rowtype;
  c           chores%rowtype;
  me          uuid := auth.uid();
  allow_cross boolean;
  verb_word   text;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then
    raise exception 'turn not found';
  end if;
  if not is_household_member(t.household_id) then
    raise exception 'not your household';
  end if;
  if t.status not in ('done', 'skipped') then
    raise exception 'that turn is not done or skipped';
  end if;

  if me is distinct from t.assignee_id then
    select allow_member_cross_complete into allow_cross
    from households where id = t.household_id;
    if not coalesce(allow_cross, false) then
      raise exception 'only the assigned member can undo this — an admin can let anyone act for anyone in Settings';
    end if;
  end if;

  verb_word := case when t.status = 'skipped' then 'skip' else 'done' end;

  select * into c from chores where id = t.chore_id;
  if c.cadence = 'standing' then
    delete from chore_turns
     where chore_id = t.chore_id and status = 'pending' and turn_number > t.turn_number;
  end if;

  update chore_turns
     set status = 'pending', completed_at = null, completed_by = null, note = null
   where id = p_turn
  returning * into t;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me, 'undid_chore',
         p.full_name || ' undid ' || verb_word || ' on ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = coalesce(me, t.assignee_id);

  return t;
end;
$$;
