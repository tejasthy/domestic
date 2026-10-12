\set ON_ERROR_STOP on

-- 0039: rotation rotates over whoever is present (no double-ups), short trips
-- earn one make-up turn on return, long ones don't, and lapsed away dates resync.
-- Names are P0..P3 in rotation order, mirroring the 4-person house in prod.

insert into households (id, name, timezone)
values ('dddddddd-dddd-dddd-dddd-ddddddddbbbb', 'Away Rotation House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data)
select ('dddddddd-0000-0000-0000-00000000000' || i)::uuid,
       'p' || i || '@awayrot.com',
       jsonb_build_object('full_name', 'P' || i, 'initials', 'P' || i,
                          'household_id', 'dddddddd-dddd-dddd-dddd-ddddddddbbbb')
from generate_series(0, 3) i;

update profiles set is_admin = true where initials = 'P0'
 and household_id = 'dddddddd-dddd-dddd-dddd-ddddddddbbbb';

-- helpers ------------------------------------------------------------------
create or replace function ar_day(d int) returns timestamptz
language sql as $$ select date_trunc('day', now()) + make_interval(days => d) $$;

create or replace function ar_seq(p_chore uuid) returns text
language sql as $$
  select string_agg(p.initials, ' ' order by t.turn_number)
  from chore_turns t join profiles p on p.id = t.assignee_id
  where t.chore_id = p_chore
$$;

create or replace function ar_chore(p_id text, p_name text, p_cadence chore_cadence)
returns uuid language plpgsql as $$
declare cid uuid := p_id::uuid;
begin
  -- every case starts with nobody away, so cases cannot contaminate each other
  delete from member_away where household_id = 'dddddddd-dddd-dddd-dddd-ddddddddbbbb';
  insert into chores (id, household_id, name, emoji, cadence, days_of_week)
  values (cid, 'dddddddd-dddd-dddd-dddd-ddddddddbbbb', p_name, '🧽', p_cadence,
          case when p_cadence = 'scheduled' then '{0,1,2,3,4,5,6}'::smallint[] else '{}'::smallint[] end);
  insert into chore_rotation (chore_id, profile_id, position)
  select cid, id, substr(initials, 2)::int from profiles
   where household_id = 'dddddddd-dddd-dddd-dddd-ddddddddbbbb' and initials like 'P_';
  return cid;
end $$;

create or replace function ar_away(p_who text, p_from int, p_to int) returns void
language sql as $$
  insert into member_away (profile_id, household_id, starts_at, ends_at)
  select id, household_id, ar_day(p_from), case when p_to is null then null else ar_day(p_to) end
  from profiles where household_id = 'dddddddd-dddd-dddd-dddd-ddddddddbbbb' and initials = p_who
$$;

create or replace function ar_append(p_chore uuid, p_from int, p_to int) returns void
language plpgsql as $$
begin
  for d in p_from..p_to loop
    perform append_turn(p_chore, ar_day(d));
  end loop;
end $$;

-- 1. nobody away: identical to the old turn % n order ------------------------
do $$
declare c uuid := ar_chore('dddddddd-1111-1111-1111-111111111111', 'Steady', 'scheduled');
begin
  perform ar_append(c, 1, 8);
  if ar_seq(c) <> 'P0 P1 P2 P3 P0 P1 P2 P3' then
    raise exception 'FAIL: steady-state order changed: %', ar_seq(c);
  end if;
end $$;
\echo '  ok  no one away: rotation order is unchanged'

-- 2. long trip: no double-ups, no make-up on return --------------------------
-- P0 is away days 5..14 (10 turns, a full rotation of the 3 present, and then
-- some). Prod showed B,B,B / T,T here.
do $$
declare c uuid := ar_chore('dddddddd-2222-2222-2222-222222222222', 'LongTrip', 'scheduled');
begin
  perform ar_away('P0', 5, 15);
  perform ar_append(c, 1, 17);
  if ar_seq(c) <> 'P0 P1 P2 P3 P1 P2 P3 P1 P2 P3 P1 P2 P3 P1 P2 P3 P0' then
    raise exception 'FAIL: long trip sequence wrong: %', ar_seq(c);
  end if;
end $$;
\echo '  ok  long trip rotates over those present: no double-ups, no make-up'

-- 3. short trip: P0 is skipped once, then makes it up on the first turn back --
do $$
declare c uuid := ar_chore('dddddddd-3333-3333-3333-333333333333', 'ShortTrip', 'scheduled');
begin
  perform ar_away('P0', 5, 7);
  perform ar_append(c, 1, 9);
  -- turns: day1-4 P0..P3 | day5 P1, day6 P2 (P0 away) | day7 P0 (make-up) | day8 P1, day9 P2
  if ar_seq(c) <> 'P0 P1 P2 P3 P1 P2 P0 P1 P2' then
    raise exception 'FAIL: short trip make-up wrong: %', ar_seq(c);
  end if;
end $$;
\echo '  ok  short trip: returner takes one make-up turn, once'

-- 4. away and straight back with no turns in between: nothing is owed --------
do $$
declare c uuid := ar_chore('dddddddd-4444-4444-4444-444444444444', 'Blip', 'scheduled');
begin
  perform ar_append(c, 1, 4);
  perform ar_away('P0', 5, 5);              -- zero-length window, no turns inside it
  perform ar_append(c, 5, 8);
  if ar_seq(c) <> 'P0 P1 P2 P3 P0 P1 P2 P3' then
    raise exception 'FAIL: a blip of away changed the order: %', ar_seq(c);
  end if;
end $$;
\echo '  ok  a trip with no turns in it costs and owes nothing'

-- 5. a trip of exactly one full rotation of those present: no make-up --------
do $$
declare c uuid := ar_chore('dddddddd-5555-5555-5555-555555555555', 'Boundary', 'scheduled');
begin
  perform ar_append(c, 1, 3);               -- P0 P1 P2 ; next slot would be P3
  perform ar_away('P3', 4, 7);              -- 3 turns during the trip == 3 present
  perform ar_append(c, 4, 9);
  -- day4 P0 (cursor P2 -> P3 away -> P0), day5 P1, day6 P2, then P3 is back on
  -- day7: no make-up, rotation just continues P0 -> after P2 comes P3.
  if ar_seq(c) <> 'P0 P1 P2 P0 P1 P2 P3 P0 P1' then
    raise exception 'FAIL: full-rotation trip should owe nothing: %', ar_seq(c);
  end if;
end $$;
\echo '  ok  trip spanning a full rotation of those present: no make-up'

-- 6. a lapsed away date resyncs pending undated turns, logs once -------------
do $$
declare c uuid := ar_chore('dddddddd-6666-6666-6666-666666666666', 'Lapse', 'on_demand');
        t chore_turns; home uuid; cover uuid;
begin
  update chores set queue_depth = 1 where id = c;
  select id into home from profiles where initials = 'P0' and household_id = 'dddddddd-dddd-dddd-dddd-ddddddddbbbb';
  select id into cover from profiles where initials = 'P1' and household_id = 'dddddddd-dddd-dddd-dddd-ddddddddbbbb';

  -- P0's turn is pending but P0 is away -> covered by P1
  insert into member_away (profile_id, household_id, starts_at, ends_at)
  values (home, 'dddddddd-dddd-dddd-dddd-ddddddddbbbb', now() - interval '2 days', now() + interval '1 day');
  perform top_up_queue(c);
  if (select assignee_id from chore_turns where chore_id = c and status = 'pending') <> cover then
    raise exception 'FAIL: expected P1 to cover while P0 is away';
  end if;

  -- the date lapses without anyone pressing "I'm back"
  update member_away set ends_at = now() - interval '1 minute'
   where profile_id = home and ends_at > now();
  -- (that UPDATE is an explicit close, which marks it handled; re-open the
  --  bookkeeping to simulate a window that simply ran out on its own)
  update member_away set lapse_handled_at = null
   where profile_id = home and ends_at <= now();

  if sync_lapsed_away() < 1 then
    raise exception 'FAIL: sync_lapsed_away should have handled the lapsed window';
  end if;
  if (select assignee_id from chore_turns where chore_id = c and status = 'pending') <> home then
    raise exception 'FAIL: turn should return to P0 once their away date lapsed';
  end if;
  if (select count(*) from activity_log where summary = 'P0 is back'
       and metadata ->> 'lapsed' = 'true') <> 1 then
    raise exception 'FAIL: expected exactly one lapsed "is back" entry';
  end if;
  if sync_lapsed_away() <> 0 then
    raise exception 'FAIL: a handled window must not be processed twice';
  end if;
end $$;
\echo '  ok  lapsed away date resyncs pending turns and logs once'

drop function ar_day(int), ar_seq(uuid), ar_chore(text, text, chore_cadence),
              ar_away(text, int, int), ar_append(uuid, int, int);
