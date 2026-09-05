\set ON_ERROR_STOP on

insert into households (id, name, timezone)
values ('1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a', 'Flag Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('1a2a1a2a-0000-0000-0000-000000000001','op@flags.com','{"full_name":"One Person","initials":"OP","household_id":"1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a"}'),
 ('1a2a1a2a-0000-0000-0000-000000000002','tp@flags.com','{"full_name":"Two Person","initials":"TP","household_id":"1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a"}'),
 ('1a2a1a2a-0000-0000-0000-000000000003','thp@flags.com','{"full_name":"Three Person","initials":"3P","household_id":"1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a"}'),
 -- In the household but deliberately left out of Dishes' rotation, so there
 -- is a housemate genuinely uninvolved in the turn below (assignee/flagger/
 -- flagged already cover OP, TP and 3P).
 ('1a2a1a2a-0000-0000-0000-000000000004','fp@flags.com','{"full_name":"Four Person","initials":"4P","household_id":"1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a"}');

insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('1a2a1a2a-1111-1111-1111-111111111111','1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a',
        'Dishes','🍽️','on_demand',1);

insert into chore_rotation (chore_id, profile_id, position)
select '1a2a1a2a-1111-1111-1111-111111111111', id,
       case initials when 'OP' then 0 when 'TP' then 1 else 2 end
from profiles
where household_id = '1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a' and initials in ('OP','TP','3P');

select top_up_queue('1a2a1a2a-1111-1111-1111-111111111111');

select set_config('request.user_id', '1a2a1a2a-0000-0000-0000-000000000002', false);

-- ---------------------------------------------------------------- flag_turn

do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '1a2a1a2a-1111-1111-1111-111111111111' and status = 'pending';

  perform flag_turn(the_turn, '1a2a1a2a-0000-0000-0000-000000000003', 'can you grab this?');

  if (select flagged_for from chore_turns where id = the_turn) <> '1a2a1a2a-0000-0000-0000-000000000003' then
    raise exception 'FAIL: flagged_for was not set';
  end if;
  if (select flagged_by from chore_turns where id = the_turn) <> '1a2a1a2a-0000-0000-0000-000000000002' then
    raise exception 'FAIL: flagged_by should be whoever flagged it, not the assignee';
  end if;
  if (select flag_note from chore_turns where id = the_turn) <> 'can you grab this?' then
    raise exception 'FAIL: flag_note was not saved';
  end if;
  if (select count(*) from activity_log where verb = 'flagged_for') <> 1 then
    raise exception 'FAIL: flagging did not write an activity entry';
  end if;
end $$;
\echo '  ok  flag_turn points a nudge at a specific person without changing the assignee'

-- flag_turn refuses a target outside the household — a random id with no
-- matching profile row exercises this exactly like a real outsider would.
do $$
declare the_turn uuid; stranger uuid := gen_random_uuid();
begin
  select id into the_turn from chore_turns
  where chore_id = '1a2a1a2a-1111-1111-1111-111111111111' and status = 'pending';

  begin
    perform flag_turn(the_turn, stranger);
    raise exception 'FAIL: flag_turn should refuse a target outside the household';
  exception when others then
    if sqlerrm not like '%not in your household%' then raise; end if;
  end;
end $$;
\echo '  ok  flag_turn refuses to flag someone outside the household'

-- ---------------------------------------------------------------- clear_flag

-- An uninvolved household member cannot clear someone else's flag.
select set_config('request.user_id', '1a2a1a2a-0000-0000-0000-000000000004', false);

do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '1a2a1a2a-1111-1111-1111-111111111111' and status = 'pending';

  begin
    perform clear_flag(the_turn);
    raise exception 'FAIL: clear_flag should refuse someone who is not the flagger, flagged, or assignee';
  exception when others then
    if sqlerrm not like '%flagger, the flagged person, or the assignee%' then raise; end if;
  end;
end $$;
\echo '  ok  clear_flag refuses an uninvolved household member'

-- The flagged person themself can clear it.
select set_config('request.user_id', '1a2a1a2a-0000-0000-0000-000000000003', false);

do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '1a2a1a2a-1111-1111-1111-111111111111' and status = 'pending';

  perform clear_flag(the_turn);

  if (select flagged_for from chore_turns where id = the_turn) is not null then
    raise exception 'FAIL: clear_flag should null out flagged_for';
  end if;
  if (select flag_note from chore_turns where id = the_turn) is not null then
    raise exception 'FAIL: clear_flag should null out flag_note';
  end if;
end $$;
\echo '  ok  clear_flag lets the flagged person dismiss their own nudge'

-- ------------------------------------------------------ auto-clear on resolve

select set_config('request.user_id', '1a2a1a2a-0000-0000-0000-000000000002', false);

do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '1a2a1a2a-1111-1111-1111-111111111111' and status = 'pending';

  perform flag_turn(the_turn, '1a2a1a2a-0000-0000-0000-000000000003');

  -- Only the assignee (OP — queue_depth 1 always lands turn 0 on position 0)
  -- can complete it without cross-complete on.
  perform set_config('request.user_id', '1a2a1a2a-0000-0000-0000-000000000001', false);
  perform complete_turn(the_turn);

  if (select flagged_for from chore_turns where id = the_turn) is not null then
    raise exception 'FAIL: completing a turn should clear any flag on it';
  end if;
end $$;
\echo '  ok  completing a turn automatically clears its flag'
