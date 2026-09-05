\set ON_ERROR_STOP on

-- Fresh household so this file does not depend on state left by smoke.sql.
insert into households (id, name, timezone)
values ('55555555-5555-5555-5555-555555555555', 'Skip/Undo Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('55555555-0000-0000-0000-000000000001','one@skipundo.com','{"full_name":"One Person","initials":"OP","household_id":"55555555-5555-5555-5555-555555555555"}'),
 ('55555555-0000-0000-0000-000000000002','two@skipundo.com','{"full_name":"Two Person","initials":"TP","household_id":"55555555-5555-5555-5555-555555555555"}');

-- OP is the household admin — needed for the admin-only cross-person skip
-- check below (0033).
update profiles set is_admin = true
 where household_id = '55555555-5555-5555-5555-555555555555' and initials = 'OP';

-- Dishes: on demand, queue of 2, rotation OP > TP
insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('55555555-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555',
        'Dishes','🍽️','on_demand',2);

insert into chore_rotation (chore_id, profile_id, position)
select '55555555-3333-3333-3333-333333333333', id,
       case initials when 'OP' then 0 else 1 end
from profiles where household_id = '55555555-5555-5555-5555-555555555555';

select top_up_queue('55555555-3333-3333-3333-333333333333');

-- ---------------------------------------------------------------- skip_turn

select set_config('request.user_id', '55555555-0000-0000-0000-000000000001', false);

do $$
declare first_turn uuid; next_who text;
begin
  select id into first_turn from chore_turns
  where chore_id='55555555-3333-3333-3333-333333333333' and status='pending'
  order by turn_number limit 1;

  perform skip_turn(first_turn, 'out of town');

  if (select status from chore_turns where id=first_turn) <> 'skipped' then
    raise exception 'FAIL: turn was not marked skipped';
  end if;
  if (select completed_by from chore_turns where id=first_turn) <> '55555555-0000-0000-0000-000000000001' then
    raise exception 'FAIL: skipped turn should record who skipped it';
  end if;

  -- the queue must refill, same as a completion
  if (select count(*) from chore_turns
      where chore_id='55555555-3333-3333-3333-333333333333' and status='pending') <> 2 then
    raise exception 'FAIL: queue did not refill after a skip (got %)',
      (select count(*) from chore_turns
       where chore_id='55555555-3333-3333-3333-333333333333' and status='pending');
  end if;

  select p.initials into next_who
  from chore_turns t join profiles p on p.id=t.assignee_id
  where t.chore_id='55555555-3333-3333-3333-333333333333' and t.status='pending'
  order by t.turn_number limit 1;

  if next_who <> 'TP' then
    raise exception 'FAIL: after OP is skipped the next up should be TP, got %', next_who;
  end if;

  if (select count(*) from activity_log where verb='skipped_chore') <> 1 then
    raise exception 'FAIL: skipping a turn did not write an activity entry';
  end if;
end $$;
\echo '  ok  skip_turn advances the rotation and refills the queue, like a completion'

-- skip_turn refuses a turn that is not pending
do $$
declare done_turn uuid;
begin
  select id into done_turn from chore_turns
  where chore_id='55555555-3333-3333-3333-333333333333' and status='skipped' limit 1;

  begin
    perform skip_turn(done_turn);
    raise exception 'FAIL: skip_turn should refuse a turn that is already skipped';
  exception when others then
    if sqlerrm not like '%not pending%' then raise; end if;
  end;
end $$;
\echo '  ok  skip_turn refuses a turn that is not pending'

-- skip_turn refuses a non-admin acting for someone else (0033: this used to
-- be gated by allow_member_cross_complete; passing/skipping someone else's
-- turn now requires the caller be a household admin instead).
select set_config('request.user_id', '55555555-0000-0000-0000-000000000002', false);

do $$
declare other_turn uuid;
begin
  select id into other_turn from chore_turns
  where chore_id='55555555-3333-3333-3333-333333333333' and status='pending'
    and assignee_id <> '55555555-0000-0000-0000-000000000002' limit 1;

  if other_turn is not null then
    begin
      perform skip_turn(other_turn);
      raise exception 'FAIL: skip_turn should refuse a non-admin acting for another member';
    exception when others then
      if sqlerrm not like '%only an admin can skip this for someone else%' then raise; end if;
    end;
  end if;
end $$;
\echo '  ok  skip_turn refuses a non-admin acting for another member'

-- ---------------------------------------------------------------- undo_turn

select set_config('request.user_id', '55555555-0000-0000-0000-000000000001', false);

do $$
declare skipped_turn uuid; pending_before int;
begin
  select id into skipped_turn from chore_turns
  where chore_id='55555555-3333-3333-3333-333333333333' and status='skipped' limit 1;

  select count(*) into pending_before from chore_turns
  where chore_id='55555555-3333-3333-3333-333333333333' and status='pending';

  perform undo_turn(skipped_turn);

  if (select status from chore_turns where id=skipped_turn) <> 'pending' then
    raise exception 'FAIL: undo_turn did not revert status to pending';
  end if;
  if (select completed_at from chore_turns where id=skipped_turn) is not null then
    raise exception 'FAIL: undo_turn left completed_at set';
  end if;
  if (select completed_by from chore_turns where id=skipped_turn) is not null then
    raise exception 'FAIL: undo_turn left completed_by set';
  end if;
  if (select note from chore_turns where id=skipped_turn) is not null then
    raise exception 'FAIL: undo_turn left the note set';
  end if;

  -- undo does not delete whatever top-up already created downstream
  if (select count(*) from chore_turns
      where chore_id='55555555-3333-3333-3333-333333333333' and status='pending') <> pending_before + 1 then
    raise exception 'FAIL: undo_turn should only flip the one turn back to pending';
  end if;

  if (select count(*) from activity_log where verb='undid_chore') <> 1 then
    raise exception 'FAIL: undoing a turn did not write an activity entry';
  end if;
end $$;
\echo '  ok  undo_turn reopens a skipped turn without touching anything downstream'

-- undo_turn works on a completed turn too, and refuses a pending one
do $$
declare a_turn uuid; b_turn uuid;
begin
  select id into a_turn from chore_turns
  where chore_id='55555555-3333-3333-3333-333333333333' and status='pending'
  order by turn_number limit 1;

  perform complete_turn(a_turn, 'washed them');
  if (select status from chore_turns where id=a_turn) <> 'done' then
    raise exception 'FAIL: setup — turn should be done before the undo check';
  end if;

  perform undo_turn(a_turn);
  if (select status from chore_turns where id=a_turn) <> 'pending' then
    raise exception 'FAIL: undo_turn did not reopen a completed turn';
  end if;

  select id into b_turn from chore_turns
  where chore_id='55555555-3333-3333-3333-333333333333' and status='pending'
  order by turn_number desc limit 1;

  begin
    perform undo_turn(b_turn);
    raise exception 'FAIL: undo_turn should refuse a turn that is still pending';
  exception when others then
    if sqlerrm not like '%not done or skipped%' then raise; end if;
  end;
end $$;
\echo '  ok  undo_turn reopens a completed turn and refuses a pending one'

-- ---------------------------------------------------- admin-only cross-skip

-- OP (admin) can skip TP's turn — the positive side of the 0033 admin gate
-- (the negative side, a non-admin refused, is covered above).
select set_config('request.user_id', '55555555-0000-0000-0000-000000000001', false);
do $$
declare tp_turn uuid;
begin
  select id into tp_turn from chore_turns
  where chore_id='55555555-3333-3333-3333-333333333333' and status='pending'
    and assignee_id='55555555-0000-0000-0000-000000000002'
  order by turn_number limit 1;
  if tp_turn is null then raise exception 'FAIL: setup — TP should have a pending turn to skip'; end if;

  perform skip_turn(tp_turn);

  if (select status from chore_turns where id=tp_turn) <> 'skipped' then
    raise exception 'FAIL: an admin should be able to skip another member''s turn';
  end if;
end $$;
\echo '  ok  an admin can skip another member''s turn'
