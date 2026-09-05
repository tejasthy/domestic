-- Optional, admin-configurable, off by default: require a member-device
-- completion to happen within a radius of the house. Kiosk completions are
-- exempt — the kiosk is physically fixed at the household's location, so a
-- distance check there is meaningless, and kiosk_complete_turn is a fully
-- separate RPC (locked to service_role since 0015) that this migration does
-- not touch. Only complete_turn is gated: skip/pass/undo aren't a presence
-- claim about doing the chore right now, so they're untouched too.
--
-- Privacy: raw lat/lon are transient RPC arguments only, never persisted —
-- chore_turns stores just a rounded distance and a boolean. This app is
-- newly open-source; precise per-completion location history would be a new,
-- unjustified PII category for what is only ever a yes/no distance check.

alter table households
  add column if not exists geofence_enabled boolean not null default false,
  add column if not exists geofence_radius_meters integer not null default 150
    check (geofence_radius_meters between 20 and 2000);

alter table chore_turns
  add column if not exists completion_distance_m integer,
  add column if not exists completion_within_geofence boolean;

/* --------------------------------------------------------------- helpers */

create or replace function haversine_meters(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
)
returns double precision
language sql
immutable
as $$
  select 6371000 * 2 * asin(least(1, sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2
    + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ^ 2
  )));
$$;

-- Refuses to enable until the household has a location set — enabling with
-- nothing to measure from would otherwise either always pass or always fail.
create or replace function set_geofence(p_enabled boolean, p_radius_meters integer default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hh  uuid;
  lat double precision;
  lon double precision;
begin
  if not is_household_admin() then
    raise exception 'only an admin can change this';
  end if;
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  if p_enabled then
    select latitude, longitude into lat, lon from households where id = hh;
    if lat is null or lon is null then
      raise exception 'set a household location first — Settings → Household → Location';
    end if;
  end if;

  update households
     set geofence_enabled = p_enabled,
         geofence_radius_meters = coalesce(p_radius_meters, geofence_radius_meters)
   where id = hh;
end;
$$;

/* ---------------------------------------------------- complete_turn (again) */

-- Adds optional p_lat/p_lon. Cannot `create or replace` a new parameter onto
-- an existing signature — drop the prior one first.
drop function if exists complete_turn(uuid, text);

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

  -- Fails closed: enabled + missing coordinates is treated the same as
  -- enabled + out of range, rather than silently skipping the check.
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
         flagged_for = null, flagged_by = null, flagged_at = null, flag_note = null,
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
