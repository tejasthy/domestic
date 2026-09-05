-- A per-person nudge, distinct from flag_on_demand (0002/0012): that one is
-- chore-wide ("the dishwasher is full") and only exists for on_demand chores.
-- This one points at a specific housemate on any pending turn ("hey, this
-- needs you") without changing who the rotation says is actually up — a
-- visible reminder, not a reassignment. Columns rather than a table: a flag
-- is a single overwritable nudge, not history worth keeping once resolved.

alter table chore_turns
  add column if not exists flagged_for uuid references profiles(id) on delete set null,
  add column if not exists flagged_by  uuid references profiles(id) on delete set null,
  add column if not exists flagged_at  timestamptz,
  add column if not exists flag_note   text
    check (flag_note is null or char_length(flag_note) <= 140);

/* --------------------------------------------------------------- flag/clear */

create or replace function flag_turn(p_turn uuid, p_target uuid, p_message text default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  t  chore_turns%rowtype;
  c  chores%rowtype;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then raise exception 'turn not found'; end if;
  if not is_household_member(t.household_id) then raise exception 'not your household'; end if;
  if t.status <> 'pending' then raise exception 'that turn is not pending'; end if;
  if not exists (select 1 from profiles where id = p_target and household_id = t.household_id) then
    raise exception 'that person is not in your household';
  end if;

  update chore_turns
     set flagged_for = p_target, flagged_by = coalesce(me, t.assignee_id),
         flagged_at = now(), flag_note = nullif(trim(coalesce(p_message, '')), '')
   where id = p_turn
  returning * into t;

  select * into c from chores where id = t.chore_id;
  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me,
         'flagged_for',
         p.full_name || ' flagged ' || c.name || ' for ' || tgt.full_name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p, profiles tgt
  where p.id = coalesce(me, t.assignee_id) and tgt.id = p_target;

  return t;
end;
$$;

-- Restricted to the people the flag actually concerns — the flagger, the
-- flagged person, or whoever the turn is assigned to — rather than any
-- household member, so a flag can't be dismissed by someone uninvolved.
create or replace function clear_flag(p_turn uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  t  chore_turns%rowtype;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then raise exception 'turn not found'; end if;
  if not is_household_member(t.household_id) then raise exception 'not your household'; end if;
  if me is distinct from t.flagged_by and me is distinct from t.flagged_for and me is distinct from t.assignee_id then
    raise exception 'only the flagger, the flagged person, or the assignee can clear this';
  end if;

  update chore_turns
     set flagged_for = null, flagged_by = null, flagged_at = null, flag_note = null
   where id = p_turn
  returning * into t;

  return t;
end;
$$;

/* -------------------------------------------- clear the flag on resolution */

-- A flag is a nudge about a turn that still needs doing; once it's resolved
-- (done or skipped) the nudge is moot. Not cleared by pass_turn (the flag
-- still applies to whoever it now lands on) or undo_turn (already null by
-- the time undo runs, since complete/skip just cleared it).

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
     set status = 'done', completed_at = now(), completed_by = coalesce(me, t.assignee_id), note = p_note,
         flagged_for = null, flagged_by = null, flagged_at = null, flag_note = null
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
     set status = 'done', completed_at = now(), completed_by = p_profile, note = p_note,
         flagged_for = null, flagged_by = null, flagged_at = null, flag_note = null
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
     set status = 'skipped', completed_at = now(), completed_by = me, note = p_note,
         flagged_for = null, flagged_by = null, flagged_at = null, flag_note = null
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
