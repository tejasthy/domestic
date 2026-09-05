\set ON_ERROR_STOP on

insert into households (id, name, timezone)
values ('3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c', 'Geofence Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('3c4c3c4c-0000-0000-0000-000000000001','op@geofence.com','{"full_name":"One Person","initials":"OP","household_id":"3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c"}'),
 ('3c4c3c4c-0000-0000-0000-000000000002','tp@geofence.com','{"full_name":"Two Person","initials":"TP","household_id":"3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c"}');

update profiles set is_admin = true
 where household_id = '3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c' and initials = 'OP';

insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('3c4c3c4c-1111-1111-1111-111111111111','3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c',
        'Dishes3','🍽️','on_demand',3);

insert into chore_rotation (chore_id, profile_id, position)
select '3c4c3c4c-1111-1111-1111-111111111111', id, 0
from profiles where household_id = '3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c' and initials = 'OP';

select top_up_queue('3c4c3c4c-1111-1111-1111-111111111111');

select set_config('request.user_id', '3c4c3c4c-0000-0000-0000-000000000001', false);

-- Cannot enable without any house coordinates on file (no address, no
-- kiosk-override location, no already-geocoded house_latitude/longitude).
do $$
begin
  begin
    perform set_geofence(true);
    raise exception 'FAIL: set_geofence should refuse to enable without a house location';
  exception when others then
    if sqlerrm not like '%set a house address first%' then raise; end if;
  end;
end $$;
\echo '  ok  set_geofence refuses to enable without a house location'

-- The app layer geocodes households.address and passes it through as
-- p_lat/p_lon (Postgres can't call the geocoder itself) — simulate that
-- here directly. Ann Arbor, MI, roughly; the exact coordinates don't matter,
-- only the relative distances used below.
do $$
begin
  perform set_geofence(true, 150, 42.2808, -83.7430);
  if not (select geofence_enabled from households where id = '3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c') then
    raise exception 'FAIL: set_geofence(true) should turn geofencing on';
  end if;
  if (select geofence_radius_meters from households where id = '3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c') <> 150 then
    raise exception 'FAIL: set_geofence should save the radius';
  end if;
  if (select house_latitude from households where id = '3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c') is distinct from 42.2808 then
    raise exception 'FAIL: set_geofence should persist the geocoded house coordinates';
  end if;
end $$;
\echo '  ok  set_geofence enables once coordinates are supplied and saves the radius'

-- Re-enabling without new coordinates keeps the ones already on file —
-- the app only re-geocodes when house_latitude/house_longitude are null.
do $$
begin
  perform set_geofence(false);
  perform set_geofence(true, 150);
  if (select house_latitude from households where id = '3c4c3c4c-3c4c-3c4c-3c4c-3c4c3c4c3c4c') is distinct from 42.2808 then
    raise exception 'FAIL: set_geofence should keep previously-geocoded coordinates when none are passed';
  end if;
end $$;
\echo '  ok  set_geofence keeps existing house coordinates across a disable/re-enable'

-- Completing from right at the house succeeds and records the audit fields.
do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '3c4c3c4c-1111-1111-1111-111111111111' and status = 'pending' limit 1;

  perform complete_turn(the_turn, null, 42.2808, -83.7430);

  if (select status from chore_turns where id = the_turn) <> 'done' then
    raise exception 'FAIL: completing from inside the radius should succeed';
  end if;
  if (select completion_within_geofence from chore_turns where id = the_turn) is not true then
    raise exception 'FAIL: completion_within_geofence should be true';
  end if;
  if (select completion_distance_m from chore_turns where id = the_turn) is null then
    raise exception 'FAIL: completion_distance_m should be recorded';
  end if;
end $$;
\echo '  ok  completing from within the radius succeeds and records distance + within-range'

-- Completing from ~10km away (well past a 150m radius) is rejected, and the
-- turn is left untouched.
do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '3c4c3c4c-1111-1111-1111-111111111111' and status = 'pending' limit 1;

  begin
    perform complete_turn(the_turn, null, 42.37, -83.7430);
    raise exception 'FAIL: complete_turn should reject a completion far outside the radius';
  exception when others then
    if sqlerrm not like '%m from the house%' then raise; end if;
  end;

  if (select status from chore_turns where id = the_turn) <> 'pending' then
    raise exception 'FAIL: a rejected completion must not change the turn''s status';
  end if;
end $$;
\echo '  ok  completing from outside the radius is rejected and leaves the turn pending'

-- Missing coordinates with geofencing on fails closed, same as out-of-range.
do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '3c4c3c4c-1111-1111-1111-111111111111' and status = 'pending' limit 1;

  begin
    perform complete_turn(the_turn);
    raise exception 'FAIL: complete_turn should refuse missing coordinates when geofencing is on';
  exception when others then
    if sqlerrm not like '%turn on location%' then raise; end if;
  end;
end $$;
\echo '  ok  completing with no coordinates fails closed when geofencing is enabled'

-- Once disabled, completion works with no coordinates and records nothing.
do $$
declare the_turn uuid;
begin
  perform set_geofence(false);

  select id into the_turn from chore_turns
  where chore_id = '3c4c3c4c-1111-1111-1111-111111111111' and status = 'pending' limit 1;

  perform complete_turn(the_turn);

  if (select status from chore_turns where id = the_turn) <> 'done' then
    raise exception 'FAIL: completion should succeed with geofencing off, even without coordinates';
  end if;
  if (select completion_distance_m from chore_turns where id = the_turn) is not null then
    raise exception 'FAIL: completion_distance_m should stay null when geofencing is off';
  end if;
end $$;
\echo '  ok  disabling geofencing removes the location requirement entirely'
