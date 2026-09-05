-- Course correction on 0022_turn_flags.sql: that migration built a whole
-- parallel per-person "nudge" system (flagged_for/flagged_by/flag_note,
-- flag_turn/clear_flag) for standing chores. The actual ask was simpler —
-- reuse the existing chore-wide flag mechanism (flag_on_demand /
-- kiosk_flag_chore, the "dishwasher's full" button) for standing chores too,
-- not build a second one. A standing chore always has exactly one pending
-- turn already visible, so flagging it has nothing to "reveal" the way
-- stamping due_at does for on_demand — it should instead just mark the
-- turn as flagged (for a shared, whole-house visible badge) and let the
-- caller notify/emphasize from there. flagged_at survives from 0022 for
-- exactly this; the per-person columns and RPCs it also added do not.

drop function if exists flag_turn(uuid, uuid, text);
drop function if exists clear_flag(uuid);

alter table chore_turns
  drop column if exists flagged_for,
  drop column if exists flagged_by,
  drop column if exists flag_note;

/* --------------------------------------------------- flag_on_demand (again) */

-- on_demand keeps stamping due_at=now() (unchanged, exact original
-- behavior/quirk: returns the turn as fetched before the update, same as
-- 0002/0012 — nothing downstream reads due_at off this return value).
-- standing has no due_at to stamp — flagged_at is the equivalent signal, and
-- unlike due_at it is never cleared on completion, since a standing chore's
-- resolution always creates a fresh turn (flagged_at null) rather than
-- reusing the flagged one.
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
  if c.cadence not in ('on_demand', 'standing') then
    raise exception 'this chore cannot be flagged';
  end if;

  perform top_up_queue(p_chore);

  select * into t from chore_turns
   where chore_id = p_chore and status = 'pending'
   order by turn_number limit 1;

  if c.cadence = 'on_demand' then
    update chore_turns set due_at = now() where id = t.id and due_at is null;
  else
    update chore_turns set flagged_at = now() where id = t.id and flagged_at is null;
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select c.household_id, auth.uid(), 'flagged_chore',
         c.name || ' needs doing',
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji);

  return t;
end;
$$;

create or replace function kiosk_flag_chore(
  p_household uuid,
  p_chore     uuid,
  p_profile   uuid
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

  select * into c from chores where id = p_chore and household_id = p_household;
  if not found then raise exception 'chore not found'; end if;
  if c.cadence not in ('on_demand', 'standing') then
    raise exception 'this chore cannot be flagged';
  end if;

  perform top_up_queue(p_chore);

  select * into t from chore_turns
   where chore_id = p_chore and status = 'pending'
   order by turn_number limit 1;

  if c.cadence = 'on_demand' then
    update chore_turns set due_at = now() where id = t.id and due_at is null;
  else
    update chore_turns set flagged_at = now() where id = t.id and flagged_at is null;
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select c.household_id, p_profile, 'flagged_chore',
         c.name || ' needs doing',
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji);

  return t;
end;
$$;

/* -------------------------------------------- drop the removed columns' refs */

-- Same bodies as 0024 (complete_turn) / 0022 (skip_turn, kiosk_complete_turn),
-- minus the flagged_for/flagged_by/flag_note clearing — those columns are
-- gone. flagged_at is deliberately left alone on completion/skip: the row
-- becomes history either way, and the next turn a top-up creates starts
-- fresh with flagged_at null, so nothing needs to null it out here.

create or replace function complete_turn(
  p_turn uuid,
  p_note text default null,
  p_lat  double precision default null,
  p_lon  double precision default null
)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t           chore_turns%rowtype;
  c           chores%rowtype;
  hh          households%rowtype;
  me          uuid := auth.uid();
  dist        double precision;
  within_geo  boolean;
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

  select * into hh from households where id = t.household_id;

  if me is distinct from t.assignee_id then
    if not coalesce(hh.allow_member_cross_complete, false) then
      raise exception 'only the assigned member can complete this — an admin can let anyone complete anyone''s chores in Settings';
    end if;
  end if;

  if hh.geofence_enabled then
    if p_lat is null or p_lon is null then
      raise exception 'turn on location to complete chores for this house';
    end if;
    dist := haversine_meters(p_lat, p_lon, hh.latitude, hh.longitude);
    within_geo := dist <= hh.geofence_radius_meters;
    if not within_geo then
      raise exception 'you''re about % m from the house — get within % m to mark this done',
        round(dist)::int, hh.geofence_radius_meters;
    end if;
  end if;

  update chore_turns
     set status = 'done', completed_at = now(), completed_by = coalesce(me, t.assignee_id), note = p_note,
         completion_distance_m = case when hh.geofence_enabled then round(dist)::int else null end,
         completion_within_geofence = case when hh.geofence_enabled then within_geo else null end
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
