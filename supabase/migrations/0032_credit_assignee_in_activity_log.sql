-- complete_turn/kiosk_complete_turn logged the *actor* as having done the
-- chore ("X did Y"), even when completing on someone else's behalf via
-- allow_member_cross_complete (or the kiosk, which has always let anyone
-- complete anyone's turn — it never checked that setting). The activity
-- feed should credit whoever the turn actually belonged to, not whoever
-- happened to tap the button. `completed_by` (the real audit column) is
-- untouched — it keeps recording the true actor either way; only the
-- feed's actor_id/summary changes.
--
-- Built on top of 0031's complete_turn (house_latitude/house_longitude,
-- not the old kiosk-override latitude/longitude) — same signature, so
-- plain create-or-replace, no drop needed.

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
    dist := haversine_meters(p_lat, p_lon, hh.house_latitude, hh.house_longitude);
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
  select t.household_id, t.assignee_id, 'completed_chore',
         p.full_name || ' did ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = t.assignee_id;

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
  select t.household_id, t.assignee_id, 'completed_chore',
         p.full_name || ' did ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = t.assignee_id;

  return t;
end;
$$;
