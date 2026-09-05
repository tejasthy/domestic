-- Away has no memory: a turn skipped because someone is "away" is just
-- handed to the next person, forever — nothing stops someone from marking
-- away for exactly the day their turn lands, then clearing it right after,
-- repeatedly, and never actually doing that chore while still looking
-- "in the rotation" the rest of the time. A single long, genuine trip is
-- fine (that's the whole point of away); the abuse pattern is *repeated,
-- separate* away periods that keep coinciding with the same chore.
--
-- This doesn't auto-punish anyone. It detects the pattern and surfaces it to
-- admins, who decide whether to act:
--   - chore_away_skips logs one row per (chore, profile, away period) the
--     first time that period causes a skip on that chore — a long trip
--     spanning many turns of the same chore is still just one row, since
--     away_id is the same for its whole duration. Counting DISTINCT away_id
--     per (chore, profile) is therefore "how many separate incidents," not
--     "how many turns."
--   - Once that count reaches the household's own member count, the pair
--     shows up in get_away_abuse_flags() for admins to review.
--   - An admin can set_chore_away_override(...) to stop letting away excuse
--     that person from that one chore going forward (rotation_assignee
--     checks this first, before is_away_at), or dismiss_away_flag(...) to
--     acknowledge it without enforcing anything — the flag reappears later
--     if the pattern continues past the point they dismissed it at.
--
-- Separately (and unconditionally, no pattern needed): admin_clear_away lets
-- an admin end a household member's away status directly, for the case where
-- someone's been away continuously for a long stretch and may have simply
-- forgotten to clear it — surfaced client-side as a plain notice, not a
-- flagged "pattern," since one long trip is exactly what away is for.

alter table chore_rotation
  add column if not exists away_override boolean not null default false,
  add column if not exists away_flag_dismissed_count smallint not null default 0;

create table if not exists chore_away_skips (
  id         uuid primary key default gen_random_uuid(),
  chore_id   uuid not null references chores(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  away_id    uuid not null references member_away(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (chore_id, profile_id, away_id)
);

create index if not exists chore_away_skips_chore_profile_idx
  on chore_away_skips (chore_id, profile_id);

alter table chore_away_skips enable row level security;

drop policy if exists chore_away_skips_read on chore_away_skips;
create policy chore_away_skips_read on chore_away_skips for select
  using (exists (select 1 from chores c where c.id = chore_id and is_household_member(c.household_id)));
-- No insert/update/delete policy — written only by rotation_assignee below.

/* --------------------------------------------------------- rotation_assignee */

-- No longer stable: it now writes a chore_away_skips row the moment it skips
-- someone for being away, so volatility must match (a stable function's
-- result can be cached/reused within a statement, which would silently drop
-- some of these log writes).
create or replace function rotation_assignee(p_chore uuid, p_turn integer, p_at timestamptz default now())
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  n           int;
  base        int;
  cand        uuid;
  overridden  boolean;
  cur_away_id uuid;
begin
  select count(*) into n from chore_rotation where chore_rotation.chore_id = p_chore;
  if n = 0 then
    return null;
  end if;

  base := p_turn % n;
  for i in 0..n - 1 loop
    select profile_id, away_override into cand, overridden
    from chore_rotation
    where chore_rotation.chore_id = p_chore
      and chore_rotation.position = (base + i) % n;

    if overridden or not is_away_at(cand, p_at) then
      return cand;
    end if;

    select id into cur_away_id from member_away
     where profile_id = cand and starts_at <= p_at and (ends_at is null or p_at < ends_at)
     order by starts_at desc limit 1;

    if cur_away_id is not null then
      insert into chore_away_skips (chore_id, profile_id, away_id)
      values (p_chore, cand, cur_away_id)
      on conflict (chore_id, profile_id, away_id) do nothing;
    end if;
  end loop;

  return null;
end;
$$;

/* --------------------------------------------------------- admin RPCs */

create or replace function get_away_abuse_flags()
returns table (
  chore_id       uuid,
  chore_name     text,
  chore_emoji    text,
  profile_id     uuid,
  profile_name   text,
  incident_count int
)
language plpgsql
security definer
set search_path = public
as $$
declare
  hh      uuid;
  hh_size int;
begin
  if not is_household_admin() then raise exception 'only an admin can see this'; end if;
  select household_id into hh from profiles where id = auth.uid();
  select count(*) into hh_size from profiles where household_id = hh;

  return query
    select c.id, c.name, c.emoji, p.id, p.full_name, count(distinct s.away_id)::int
    from chore_away_skips s
    join chores c on c.id = s.chore_id
    join profiles p on p.id = s.profile_id
    join chore_rotation cr on cr.chore_id = s.chore_id and cr.profile_id = s.profile_id
    where c.household_id = hh
      and not cr.away_override
    group by c.id, c.name, c.emoji, p.id, p.full_name, cr.away_flag_dismissed_count
    having count(distinct s.away_id) >= hh_size
       and count(distinct s.away_id) > cr.away_flag_dismissed_count;
end;
$$;

create or replace function set_chore_away_override(p_chore uuid, p_profile uuid, p_enforce boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hh uuid;
begin
  if not is_household_admin() then raise exception 'only an admin can change this'; end if;
  select household_id into hh from profiles where id = auth.uid();
  if not exists (select 1 from chores where id = p_chore and household_id = hh) then
    raise exception 'that chore is not in your household';
  end if;

  update chore_rotation set away_override = p_enforce
   where chore_id = p_chore and profile_id = p_profile;
  if not found then raise exception 'that person is not in this chore''s rotation'; end if;

  perform resync_pending_turns(p_chore);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select hh, auth.uid(),
         case when p_enforce then 'away_override_enabled' else 'away_override_disabled' end,
         case when p_enforce
           then pr.full_name || ' no longer gets skipped by away on ' || c.name
           else pr.full_name || ' can be skipped by away on ' || c.name || ' again'
         end,
         jsonb_build_object('chore_id', c.id, 'profile_id', p_profile, 'emoji', c.emoji)
  from chores c, profiles pr
  where c.id = p_chore and pr.id = p_profile;
end;
$$;

create or replace function dismiss_away_flag(p_chore uuid, p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hh uuid;
  n  int;
begin
  if not is_household_admin() then raise exception 'only an admin can change this'; end if;
  select household_id into hh from profiles where id = auth.uid();
  if not exists (select 1 from chores where id = p_chore and household_id = hh) then
    raise exception 'that chore is not in your household';
  end if;

  select count(distinct away_id) into n from chore_away_skips
   where chore_id = p_chore and profile_id = p_profile;

  update chore_rotation set away_flag_dismissed_count = n
   where chore_id = p_chore and profile_id = p_profile;
  if not found then raise exception 'that person is not in this chore''s rotation'; end if;
end;
$$;

-- Unconditional, no pattern required: a long, genuine trip is exactly what
-- away is for, but someone can simply forget to clear it once they're back.
-- Lets an admin end it on someone else's behalf; the client surfaces this as
-- a plain "still away?" notice once a member's current away period has run
-- 14+ continuous days, not as a flagged pattern.
create or replace function admin_clear_away(p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hh   uuid;
  name text;
  c    record;
begin
  if not is_household_admin() then raise exception 'only an admin can change this'; end if;
  select household_id into hh from profiles where id = auth.uid();
  if not exists (select 1 from profiles where id = p_profile and household_id = hh) then
    raise exception 'that person is not in your household';
  end if;

  select full_name into name from profiles where id = p_profile;

  update member_away
     set ends_at = now()
   where profile_id = p_profile
     and starts_at <= now()
     and (ends_at is null or now() < ends_at);

  for c in select id, cadence from chores where household_id = hh and is_active loop
    perform resync_pending_turns(c.id);
    if c.cadence = 'on_demand' then
      perform top_up_queue(c.id);
    end if;
  end loop;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (hh, auth.uid(), 'cleared_away', name || ' was marked back by an admin', '{}'::jsonb);
end;
$$;

-- Doing the chore is what actually earns back a clean slate: both completion
-- paths wipe this chore's logged away-skip incidents for the assignee (and
-- the dismissed-count bookkeeping along with them), so a fresh h incidents
-- are needed before the pattern flags again. Everything else here is copied
-- verbatim from 0032's complete_turn/kiosk_complete_turn — only that one
-- reset is new.
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

  delete from chore_away_skips
   where chore_id = t.chore_id and profile_id = t.assignee_id;
  update chore_rotation set away_flag_dismissed_count = 0
   where chore_id = t.chore_id and profile_id = t.assignee_id;

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

  delete from chore_away_skips
   where chore_id = t.chore_id and profile_id = t.assignee_id;
  update chore_rotation set away_flag_dismissed_count = 0
   where chore_id = t.chore_id and profile_id = t.assignee_id;

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
