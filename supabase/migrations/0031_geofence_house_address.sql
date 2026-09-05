-- The "require members to be nearby" geofence was centered on
-- households.latitude/longitude — the kiosk's optional wall-display weather
-- override — so an admin had to configure that override just to turn the
-- geofence on, even for a house that already has an address on file. Give
-- the geofence its own coordinates, geocoded from households.address, so it
-- no longer depends on the kiosk override being set.
--
-- Postgres can't call the geocoder itself, so the app layer resolves
-- address -> lat/lon (via the same Open-Meteo geocoder the kiosk weather
-- fallback already uses, see src/lib/weather.ts geocodeHouseAddress) and
-- passes it through set_geofence, which persists it here.

alter table households
  add column if not exists house_latitude double precision,
  add column if not exists house_longitude double precision;

-- Households that already had geofencing on were relying on the kiosk
-- override as their center — carry that over so this migration doesn't
-- silently turn a working geofence into one that always fails.
update households
   set house_latitude = latitude,
       house_longitude = longitude
 where geofence_enabled and house_latitude is null;

/* --------------------------------------------------------------- set_geofence */

-- Adds optional p_lat/p_lon so the app can supply freshly-geocoded house
-- coordinates in the same call that turns geofencing on.
drop function if exists set_geofence(boolean, integer);

create or replace function set_geofence(
  p_enabled       boolean,
  p_radius_meters integer default null,
  p_lat           double precision default null,
  p_lon           double precision default null
)
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

  select house_latitude, house_longitude into lat, lon from households where id = hh;

  if p_enabled and (coalesce(p_lat, lat) is null or coalesce(p_lon, lon) is null) then
    raise exception 'set a house address first — Settings → Household';
  end if;

  update households
     set geofence_enabled = p_enabled,
         geofence_radius_meters = coalesce(p_radius_meters, geofence_radius_meters),
         house_latitude = coalesce(p_lat, house_latitude),
         house_longitude = coalesce(p_lon, house_longitude)
   where id = hh;
end;
$$;

/* ---------------------------------------------------- complete_turn (again) */

-- Same body as 0028's complete_turn, just measuring against house_latitude/
-- house_longitude instead of the kiosk override's latitude/longitude.
drop function if exists complete_turn(uuid, text, double precision, double precision);

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
  select t.household_id, coalesce(me, t.assignee_id), 'completed_chore',
         p.full_name || ' did ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = coalesce(me, t.assignee_id);

  return t;
end;
$$;
