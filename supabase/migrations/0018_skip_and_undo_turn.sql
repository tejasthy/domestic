-- Two escape hatches for the rotation: skip a pending turn when the person
-- up is out of town, and undo a turn that was completed or skipped by
-- mistake. Both reuse the rotation engine's own machinery
-- (top_up_queue/materialize_schedule) instead of poking chore_turns by hand,
-- and both honor the same allow_member_cross_complete gate complete_turn
-- already enforces (0012_kiosk_interactivity.sql) so "who can act for whom"
-- stays in one place.

-- Marks a pending turn 'skipped' (the turn_status value has existed since
-- 0001 but nothing set it) and immediately opens the next turn, same as
-- complete_turn. turn_number is untouched, so the rest of the rotation still
-- lands on the right person -- skipping turn N just means nobody did N.
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

  if c.cadence = 'on_demand' then
    perform top_up_queue(t.chore_id);
  else
    perform materialize_schedule(t.chore_id);
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

-- Reverts a 'done' or 'skipped' turn back to 'pending', clearing the fields
-- complete_turn/skip_turn set. Safe on any turn regardless of what has
-- happened since: turn_number is immutable and never reused, so reopening
-- turn N cannot desync anyone else's position in the cycle. Whatever
-- top_up_queue/materialize_schedule already created downstream is left
-- alone -- an on-demand chore just runs one turn over its queue_depth until
-- the next completion naturally lets it settle back down.
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

  update chore_turns
     set status = 'pending', completed_at = null, completed_by = null, note = null
   where id = p_turn
  returning * into t;

  select * into c from chores where id = t.chore_id;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me, 'undid_chore',
         p.full_name || ' undid ' || verb_word || ' on ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = coalesce(me, t.assignee_id);

  return t;
end;
$$;
