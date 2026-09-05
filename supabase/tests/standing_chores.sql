\set ON_ERROR_STOP on

-- Fresh household so this file does not depend on state left by other tests.
insert into households (id, name, timezone)
values ('77777777-7777-7777-7777-777777777777', 'Standing Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('77777777-0000-0000-0000-000000000001','op@standing.com','{"full_name":"One Person","initials":"OP","household_id":"77777777-7777-7777-7777-777777777777"}'),
 ('77777777-0000-0000-0000-000000000002','tp@standing.com','{"full_name":"Two Person","initials":"TP","household_id":"77777777-7777-7777-7777-777777777777"}');

-- Recycling: standing, rotation OP(0) > TP(1).
insert into chores (id, household_id, name, emoji, cadence)
values ('77777777-1111-1111-1111-111111111111','77777777-7777-7777-7777-777777777777',
        'Recycling','♻️','standing');

insert into chore_rotation (chore_id, profile_id, position)
select '77777777-1111-1111-1111-111111111111', id,
       case initials when 'OP' then 0 else 1 end
from profiles where household_id = '77777777-7777-7777-7777-777777777777';

-- --------------------------------------------------------------- top-up

do $$
declare pending_count int; first_turn record;
begin
  perform top_up_queue('77777777-1111-1111-1111-111111111111');

  select count(*) into pending_count from chore_turns
  where chore_id = '77777777-1111-1111-1111-111111111111' and status = 'pending';
  if pending_count <> 1 then
    raise exception 'FAIL: a standing chore should keep exactly one pending turn (got %)', pending_count;
  end if;

  select * into first_turn from chore_turns
  where chore_id = '77777777-1111-1111-1111-111111111111' and status = 'pending';
  if first_turn.due_at is not null then
    raise exception 'FAIL: a standing turn should have no due date';
  end if;
  if first_turn.assignee_id <> '77777777-0000-0000-0000-000000000001' then
    raise exception 'FAIL: turn 0 should go to OP';
  end if;
end $$;
\echo '  ok  top_up_queue keeps exactly one always-visible, due-date-free turn for a standing chore'

-- ------------------------------------------------------------ baton pass

select set_config('request.user_id', '77777777-0000-0000-0000-000000000001', false);

do $$
declare first_turn uuid; pending_count int; next_who text;
begin
  select id into first_turn from chore_turns
  where chore_id = '77777777-1111-1111-1111-111111111111' and status = 'pending';

  perform complete_turn(first_turn);

  select count(*) into pending_count from chore_turns
  where chore_id = '77777777-1111-1111-1111-111111111111' and status = 'pending';
  if pending_count <> 1 then
    raise exception 'FAIL: completing a standing turn should leave exactly one new pending turn (got %)', pending_count;
  end if;

  select p.initials into next_who
  from chore_turns t join profiles p on p.id = t.assignee_id
  where t.chore_id = '77777777-1111-1111-1111-111111111111' and t.status = 'pending';
  if next_who <> 'TP' then
    raise exception 'FAIL: completing OP''s standing turn should instantly pass the baton to TP, got %', next_who;
  end if;
end $$;
\echo '  ok  completing a standing turn instantly passes the baton to the next person'

-- ---------------------------------------------------------------- undo

do $$
declare done_turn uuid; pending_count int; owner text;
begin
  select id into done_turn from chore_turns
  where chore_id = '77777777-1111-1111-1111-111111111111' and status = 'done';

  perform undo_turn(done_turn);

  select count(*) into pending_count from chore_turns
  where chore_id = '77777777-1111-1111-1111-111111111111' and status = 'pending';
  if pending_count <> 1 then
    raise exception 'FAIL: undoing a standing completion should leave exactly one pending turn, not two (got %)', pending_count;
  end if;

  select p.initials into owner
  from chore_turns t join profiles p on p.id = t.assignee_id
  where t.chore_id = '77777777-1111-1111-1111-111111111111' and t.status = 'pending';
  if owner <> 'OP' then
    raise exception 'FAIL: undoing should hand the standing chore back to OP, got %', owner;
  end if;

  if (select status from chore_turns where id = done_turn) <> 'pending' then
    raise exception 'FAIL: the undone turn itself should be pending again';
  end if;
end $$;
\echo '  ok  undo_turn on a standing chore deletes the phantom next turn instead of leaving two pending'

-- --------------------------------------------------------------- skip too

do $$
declare cur_turn uuid; pending_count int;
begin
  select id into cur_turn from chore_turns
  where chore_id = '77777777-1111-1111-1111-111111111111' and status = 'pending';

  perform skip_turn(cur_turn, 'not my week');

  select count(*) into pending_count from chore_turns
  where chore_id = '77777777-1111-1111-1111-111111111111' and status = 'pending';
  if pending_count <> 1 then
    raise exception 'FAIL: skipping a standing turn should also leave exactly one new pending turn (got %)', pending_count;
  end if;

  perform undo_turn(cur_turn);
  select count(*) into pending_count from chore_turns
  where chore_id = '77777777-1111-1111-1111-111111111111' and status = 'pending';
  if pending_count <> 1 then
    raise exception 'FAIL: undoing a skipped standing turn should also collapse back to one pending turn (got %)', pending_count;
  end if;
end $$;
\echo '  ok  skip_turn and its undo behave the same way on a standing chore'
