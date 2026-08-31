\set ON_ERROR_STOP on

-- Fresh household so this file does not depend on state left by other tests.
insert into households (id, name, timezone)
values ('66666666-6666-6666-6666-666666666666', 'Away Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('66666666-0000-0000-0000-000000000001','op@awaytest.com','{"full_name":"One Person","initials":"OP","household_id":"66666666-6666-6666-6666-666666666666"}'),
 ('66666666-0000-0000-0000-000000000002','tp@awaytest.com','{"full_name":"Two Person","initials":"TP","household_id":"66666666-6666-6666-6666-666666666666"}'),
 ('66666666-0000-0000-0000-000000000003','thp@awaytest.com','{"full_name":"Three Person","initials":"3P","household_id":"66666666-6666-6666-6666-666666666666"}');

-- Trash: scheduled, 3-person rotation OP(0) > TP(1) > 3P(2). Turns are
-- inserted by hand throughout so due dates are exact and independent of
-- wall-clock day boundaries.
insert into chores (id, household_id, name, emoji, cadence, days_of_week)
values ('66666666-1111-1111-1111-111111111111','66666666-6666-6666-6666-666666666666',
        'Trash','🗑️','scheduled','{0,1,2,3,4,5,6}');

insert into chore_rotation (chore_id, profile_id, position)
select '66666666-1111-1111-1111-111111111111', id,
       case initials when 'OP' then 0 when 'TP' then 1 else 2 end
from profiles where household_id = '66666666-6666-6666-6666-666666666666';

-- Solo: on-demand, single-person rotation (OP only).
insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('66666666-2222-2222-2222-222222222222','66666666-6666-6666-6666-666666666666',
        'Solo','🧻','on_demand',1);

insert into chore_rotation (chore_id, profile_id, position)
select '66666666-2222-2222-2222-222222222222', id, 0
from profiles where household_id = '66666666-6666-6666-6666-666666666666' and initials = 'OP';

-- Floors: scheduled, 2-person rotation OP(0) > TP(1). Never materialized
-- until the pause/resume group at the end, so it starts with zero turns.
insert into chores (id, household_id, name, emoji, cadence, days_of_week)
values ('66666666-4444-4444-4444-444444444444','66666666-6666-6666-6666-666666666666',
        'Floors','🧹','scheduled','{0,1,2,3,4,5,6}');

insert into chore_rotation (chore_id, profile_id, position)
select '66666666-4444-4444-4444-444444444444', id,
       case initials when 'OP' then 0 else 1 end
from profiles where household_id = '66666666-6666-6666-6666-666666666666' and initials in ('OP','TP');

-- ------------------------------------------------------------- pass_turn

select set_config('request.user_id', '66666666-0000-0000-0000-000000000001', false);

do $$
declare a1 uuid; due timestamptz := now() + interval '1 day';
begin
  insert into chore_turns (id, chore_id, household_id, turn_number, assignee_id, status, due_at)
  values (gen_random_uuid(), '66666666-1111-1111-1111-111111111111',
          '66666666-6666-6666-6666-666666666666', 100,
          '66666666-0000-0000-0000-000000000001', 'pending', due)
  returning id into a1;

  perform pass_turn(a1);

  if (select assignee_id from chore_turns where id = a1) <> '66666666-0000-0000-0000-000000000002' then
    raise exception 'FAIL: pass_turn should hand the turn to the next rotation member (TP)';
  end if;
  if (select status from chore_turns where id = a1) <> 'pending' then
    raise exception 'FAIL: pass_turn must leave the turn pending, not settle it';
  end if;
  if (select due_at from chore_turns where id = a1) <> due then
    raise exception 'FAIL: pass_turn must not change the due date';
  end if;
  if (select turn_number from chore_turns where id = a1) <> 100 then
    raise exception 'FAIL: pass_turn must not change the turn number';
  end if;
  if (select count(*) from activity_log where verb = 'passed_chore') <> 1 then
    raise exception 'FAIL: passing a turn did not write an activity entry';
  end if;
end $$;
\echo '  ok  pass_turn hands the turn to the next person, same day, same turn'

-- pass_turn refuses when there is no one else in the rotation
do $$
declare solo_turn uuid;
begin
  perform top_up_queue('66666666-2222-2222-2222-222222222222');
  select id into solo_turn from chore_turns
  where chore_id = '66666666-2222-2222-2222-222222222222' and status = 'pending' limit 1;

  begin
    perform pass_turn(solo_turn);
    raise exception 'FAIL: pass_turn should refuse when the rotation is one person';
  exception when others then
    if sqlerrm not like '%no one else%' then raise; end if;
  end;
end $$;
\echo '  ok  pass_turn refuses a single-person rotation'

-- pass_turn refuses when everyone else in the rotation is away
select set_config('request.user_id', '66666666-0000-0000-0000-000000000002', false);
select set_away();

do $$
begin
  if (select assignee_id from chore_turns where turn_number = 100
      and chore_id = '66666666-1111-1111-1111-111111111111') <> '66666666-0000-0000-0000-000000000003' then
    raise exception 'FAIL: TP going away should hand turn 100 to 3P';
  end if;
end $$;
\echo '  ok  set_away hands an already-pending turn to the next available person'

select set_config('request.user_id', '66666666-0000-0000-0000-000000000003', false);
select set_away();

do $$
begin
  if (select assignee_id from chore_turns where turn_number = 100
      and chore_id = '66666666-1111-1111-1111-111111111111') <> '66666666-0000-0000-0000-000000000001' then
    raise exception 'FAIL: 3P going away too should fall back to OP, the only one left';
  end if;
end $$;

select set_config('request.user_id', '66666666-0000-0000-0000-000000000001', false);

do $$
declare a1 uuid;
begin
  select id into a1 from chore_turns where turn_number = 100
   and chore_id = '66666666-1111-1111-1111-111111111111';

  begin
    perform pass_turn(a1);
    raise exception 'FAIL: pass_turn should refuse when everyone else is away';
  exception when others then
    if sqlerrm not like '%everyone else is away%' then raise; end if;
  end;
end $$;
\echo '  ok  pass_turn refuses when everyone else in the rotation is away'

-- ------------------------------------------ set_away is due-date aware,
-- and pauses (auto-skips) a chore nobody can be assigned to

-- Reset TP and 3P to a clean, not-away baseline.
select set_config('request.user_id', '66666666-0000-0000-0000-000000000002', false);
select clear_away();
select set_config('request.user_id', '66666666-0000-0000-0000-000000000003', false);
select clear_away();

select set_config('request.user_id', '66666666-0000-0000-0000-000000000001', false);

do $$
declare
  turn_soon uuid; turn_later uuid;
  soon timestamptz := now() + interval '3 days';
  later timestamptz := now() + interval '10 days';
  return_date timestamptz := now() + interval '5 days';
  skipped_before int;
begin
  -- turn_number 201 and 204 both derive to OP (position 0) in this 3-person
  -- rotation, so any reassignment below is caused by OP's away window, not
  -- by resync merely correcting a pre-existing mismatch.
  insert into chore_turns (id, chore_id, household_id, turn_number, assignee_id, status, due_at)
  values (gen_random_uuid(), '66666666-1111-1111-1111-111111111111',
          '66666666-6666-6666-6666-666666666666', 201,
          '66666666-0000-0000-0000-000000000001', 'pending', soon)
  returning id into turn_soon;

  insert into chore_turns (id, chore_id, household_id, turn_number, assignee_id, status, due_at)
  values (gen_random_uuid(), '66666666-1111-1111-1111-111111111111',
          '66666666-6666-6666-6666-666666666666', 204,
          '66666666-0000-0000-0000-000000000001', 'pending', later)
  returning id into turn_later;

  select count(*) into skipped_before from chore_turns
  where chore_id = '66666666-2222-2222-2222-222222222222' and status = 'skipped';

  perform set_away(return_date);

  if (select assignee_id from chore_turns where id = turn_soon) = '66666666-0000-0000-0000-000000000001' then
    raise exception 'FAIL: a turn due inside the away window should move off OP';
  end if;
  if (select assignee_id from chore_turns where id = turn_later) <> '66666666-0000-0000-0000-000000000001' then
    raise exception 'FAIL: a turn due after the return date should stay with OP';
  end if;

  -- Solo has only OP in its rotation: with OP away right now, nobody can
  -- take its pending turn, so it must pause (auto-skip), not error.
  if (select count(*) from chore_turns
      where chore_id = '66666666-2222-2222-2222-222222222222' and status = 'skipped') <> skipped_before + 1 then
    raise exception 'FAIL: Solo''s pending turn should auto-skip while its only member is away';
  end if;
  if (select count(*) from chore_turns
      where chore_id = '66666666-2222-2222-2222-222222222222' and status = 'pending') <> 0 then
    raise exception 'FAIL: Solo should have no pending turn while everyone in its rotation is away';
  end if;
end $$;
\echo '  ok  set_away reassigns turns due inside the window, leaves later ones alone, and pauses a fully-away chore'

-- clear_away hands turns back and does not resurrect what was already
-- skipped or reassigned during the away window.
do $$
declare skipped_before int; pending_before int;
begin
  select count(*) into skipped_before from chore_turns
  where chore_id = '66666666-2222-2222-2222-222222222222' and status = 'skipped';
  select count(*) into pending_before from chore_turns
  where chore_id = '66666666-2222-2222-2222-222222222222' and status = 'pending';

  perform clear_away();

  if (select assignee_id from chore_turns where turn_number = 201
      and chore_id = '66666666-1111-1111-1111-111111111111') <> '66666666-0000-0000-0000-000000000001' then
    raise exception 'FAIL: clearing away should hand the near-term turn back to OP';
  end if;

  -- the queue tops back up (a fresh turn), but the old skipped one stays skipped
  if (select count(*) from chore_turns
      where chore_id = '66666666-2222-2222-2222-222222222222' and status = 'skipped') <> skipped_before then
    raise exception 'FAIL: clear_away must not resurrect a turn that was already skipped';
  end if;
  if (select count(*) from chore_turns
      where chore_id = '66666666-2222-2222-2222-222222222222' and status = 'pending') <> pending_before + 1 then
    raise exception 'FAIL: Solo''s queue should top back up once OP is available again';
  end if;
end $$;
\echo '  ok  clear_away hands turns back without resurrecting what was already settled'

-- --------------------------------------- materialize_schedule/top_up_queue
-- pause a fully-away rotation and resume once someone is available

select set_config('request.user_id', '66666666-0000-0000-0000-000000000001', false);
select set_away();
select set_config('request.user_id', '66666666-0000-0000-0000-000000000002', false);
select set_away();

do $$
declare made int;
begin
  made := materialize_schedule('66666666-4444-4444-4444-444444444444');
  if made <> 0 then
    raise exception 'FAIL: materialize_schedule should create nothing while the whole rotation is away (made %)', made;
  end if;
  if (select count(*) from chore_turns where chore_id = '66666666-4444-4444-4444-444444444444') <> 0 then
    raise exception 'FAIL: no Floors turns should exist while everyone is away';
  end if;
end $$;
\echo '  ok  materialize_schedule pauses a chore whose entire rotation is away'

select set_config('request.user_id', '66666666-0000-0000-0000-000000000002', false);
select clear_away();

do $$
declare made int; others int;
begin
  made := materialize_schedule('66666666-4444-4444-4444-444444444444');
  if made <= 0 then
    raise exception 'FAIL: materialize_schedule should resume once TP is back';
  end if;

  select count(*) into others from chore_turns
  where chore_id = '66666666-4444-4444-4444-444444444444'
    and assignee_id <> '66666666-0000-0000-0000-000000000002';
  if others <> 0 then
    raise exception 'FAIL: every new Floors turn should go to TP while OP is still away';
  end if;
end $$;
\echo '  ok  materialize_schedule resumes for whoever is back, still skipping whoever is still away'
