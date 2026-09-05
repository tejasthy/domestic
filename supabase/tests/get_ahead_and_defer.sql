\set ON_ERROR_STOP on

-- get_ahead/defer_turn (0029) — a queue-position swap, never completing or
-- pushing a due date. get_ahead trades your own upcoming turn for whoever
-- currently holds the chore; defer hands your current turn to the next
-- person and takes their upcoming one instead.

insert into households (id, name, timezone)
values ('2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b', 'Get Ahead Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('2b3b2b3b-0000-0000-0000-000000000001','op@ahead.com','{"full_name":"One Person","initials":"OP","household_id":"2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b"}'),
 ('2b3b2b3b-0000-0000-0000-000000000002','tp@ahead.com','{"full_name":"Two Person","initials":"TP","household_id":"2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b"}'),
 ('2b3b2b3b-0000-0000-0000-000000000003','thp@ahead.com','{"full_name":"Three Person","initials":"3P","household_id":"2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b"}'),
 ('2b3b2b3b-0000-0000-0000-000000000004','fp@ahead.com','{"full_name":"Four Person","initials":"4P","household_id":"2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b"}');

-- Dishes2: on demand, queue of 3, rotation OP(0) > TP(1) > 3P(2). 4P is a
-- household member deliberately left out of this chore's rotation.
insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('2b3b2b3b-1111-1111-1111-111111111111','2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b',
        'Dishes2','🍽️','on_demand',3);

insert into chore_rotation (chore_id, profile_id, position)
select '2b3b2b3b-1111-1111-1111-111111111111', id,
       case initials when 'OP' then 0 when 'TP' then 1 else 2 end
from profiles
where household_id = '2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b' and initials in ('OP','TP','3P');

-- Trash2: scheduled, every day, rotation OP(0) > TP(1) — always has a "next
-- matching date" so the walk-forward search never runs out of room.
insert into chores (id, household_id, name, emoji, cadence, days_of_week, anchor_date)
values ('2b3b2b3b-2222-2222-2222-222222222222','2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b',
        'Trash2','🗑️','scheduled','{0,1,2,3,4,5,6}', current_date);

insert into chore_rotation (chore_id, profile_id, position)
select '2b3b2b3b-2222-2222-2222-222222222222', id,
       case initials when 'OP' then 0 else 1 end
from profiles
where household_id = '2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b' and initials in ('OP','TP');

-- StandingX: to confirm both RPCs reject this cadence outright.
insert into chores (id, household_id, name, emoji, cadence)
values ('2b3b2b3b-3333-3333-3333-333333333333','2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b',
        'StandingX','♻️','standing');

insert into chore_rotation (chore_id, profile_id, position)
select '2b3b2b3b-3333-3333-3333-333333333333', id,
       case initials when 'OP' then 0 else 1 end
from profiles
where household_id = '2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b' and initials in ('OP','TP');

select top_up_queue('2b3b2b3b-1111-1111-1111-111111111111');
select materialize_schedule('2b3b2b3b-2222-2222-2222-222222222222');
select top_up_queue('2b3b2b3b-3333-3333-3333-333333333333');

/* ================================================================ get_ahead */

-- Current turn (turn 0) is OP's. TP wants to get ahead of OP.
select set_config('request.user_id', '2b3b2b3b-0000-0000-0000-000000000002', false);

do $$
declare current_turn_id uuid; tp_future_turn_id uuid; owner text;
begin
  select id into current_turn_id from chore_turns
  where chore_id = '2b3b2b3b-1111-1111-1111-111111111111' and turn_number = 0;
  select id into tp_future_turn_id from chore_turns
  where chore_id = '2b3b2b3b-1111-1111-1111-111111111111' and turn_number = 1;

  perform get_ahead('2b3b2b3b-1111-1111-1111-111111111111');

  select p.initials into owner from chore_turns t join profiles p on p.id = t.assignee_id
  where t.id = current_turn_id;
  if owner <> 'TP' then raise exception 'FAIL: get_ahead should hand the current turn to the caller (TP), got %', owner; end if;
  if (select status from chore_turns where id = current_turn_id) <> 'pending' then
    raise exception 'FAIL: get_ahead must not complete anything — the turn stays pending';
  end if;

  select p.initials into owner from chore_turns t join profiles p on p.id = t.assignee_id
  where t.id = tp_future_turn_id;
  if owner <> 'OP' then raise exception 'FAIL: OP should now hold TP''s former upcoming turn, got %', owner; end if;

  -- 3P's turn (turn 2) is untouched — get_ahead only swaps the two parties.
  if (select p.initials from chore_turns t join profiles p on p.id = t.assignee_id
      where t.chore_id = '2b3b2b3b-1111-1111-1111-111111111111' and t.turn_number = 2) <> '3P' then
    raise exception 'FAIL: get_ahead must not touch anyone else''s turn';
  end if;

  if (select count(*) from chore_advance_log where turn_id = current_turn_id and kind = 'get_ahead') <> 1 then
    raise exception 'FAIL: get_ahead should log itself';
  end if;
end $$;
\echo '  ok  get_ahead swaps the caller into the current turn and the displaced person into the caller''s upcoming one'

-- Self-limiting: TP now holds the current turn, so a second attempt is refused.
do $$
begin
  begin
    perform get_ahead('2b3b2b3b-1111-1111-1111-111111111111');
    raise exception 'FAIL: get_ahead should refuse once it is already the caller''s turn';
  exception when others then
    if sqlerrm not like '%already your turn%' then raise; end if;
  end;
end $$;
\echo '  ok  get_ahead refuses when it is already the caller''s turn'

-- Default limit: 1 use per rolling 30 days — tested by having someone else
-- cycle the current turn away from TP first (pass_turn), so TP is free to
-- attempt get_ahead again without tripping the self-limiting guard above.
do $$
declare current_turn_id uuid;
begin
  select id into current_turn_id from chore_turns
  where chore_id = '2b3b2b3b-1111-1111-1111-111111111111' and turn_number = 0;
  perform pass_turn(current_turn_id); -- TP -> 3P (next in rotation order)

  begin
    perform get_ahead('2b3b2b3b-1111-1111-1111-111111111111');
    raise exception 'FAIL: get_ahead should refuse a second use inside 30 days';
  exception when others then
    if sqlerrm not like '%last 30 days%' then raise; end if;
  end;
end $$;
\echo '  ok  get_ahead enforces the default once-per-30-days limit'

-- Someone outside the chore's rotation can't get ahead on it.
select set_config('request.user_id', '2b3b2b3b-0000-0000-0000-000000000004', false);
do $$
begin
  begin
    perform get_ahead('2b3b2b3b-1111-1111-1111-111111111111');
    raise exception 'FAIL: get_ahead should refuse someone not in the rotation';
  exception when others then
    if sqlerrm not like '%not in this chore%rotation%' then raise; end if;
  end;
end $$;
\echo '  ok  get_ahead refuses someone outside the chore''s rotation'

-- Standing chores are excluded outright.
select set_config('request.user_id', '2b3b2b3b-0000-0000-0000-000000000001', false);
do $$
begin
  begin
    perform get_ahead('2b3b2b3b-3333-3333-3333-333333333333');
    raise exception 'FAIL: get_ahead should refuse a standing chore';
  exception when others then
    if sqlerrm not like '%standing chores%' then raise; end if;
  end;
end $$;
\echo '  ok  get_ahead refuses standing chores'

-- The household can turn the whole feature off.
insert into household_modules (household_id, module, enabled)
values ('2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b', 'get_ahead', false)
on conflict (household_id, module) do update set enabled = excluded.enabled;
do $$
begin
  begin
    perform get_ahead('2b3b2b3b-1111-1111-1111-111111111111');
    raise exception 'FAIL: get_ahead should refuse once the household has turned it off';
  exception when others then
    if sqlerrm not like '%turned off for this house%' then raise; end if;
  end;
end $$;
\echo '  ok  get_ahead respects the household on/off toggle'

-- Back on, with a generous 30-day allowance, for the defer tests below.
insert into household_modules (household_id, module, enabled, settings)
values ('2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b', 'get_ahead', true,
        '{"get_ahead":{"max_per_30d":5},"defer":{"max_per_30d":5}}'::jsonb)
on conflict (household_id, module) do update set enabled = excluded.enabled, settings = excluded.settings;

/* =================================================================== defer */

select set_config('request.user_id', '2b3b2b3b-0000-0000-0000-000000000001', false);

do $$
declare current_turn_id uuid; op_future_turn_id uuid; owner text; n_before int; n_after int;
begin
  select id into current_turn_id from chore_turns
  where chore_id = '2b3b2b3b-2222-2222-2222-222222222222' and status = 'pending'
    and assignee_id = '2b3b2b3b-0000-0000-0000-000000000001'
  order by turn_number limit 1;
  if current_turn_id is null then raise exception 'FAIL: setup — OP should have a current Trash2 turn'; end if;

  select count(*) into n_before from chore_turns where chore_id = '2b3b2b3b-2222-2222-2222-222222222222';

  perform defer_turn(current_turn_id);

  select p.initials into owner from chore_turns t join profiles p on p.id = t.assignee_id
  where t.id = current_turn_id;
  if owner <> 'TP' then raise exception 'FAIL: defer should hand the current turn to the next person (TP), got %', owner; end if;
  if (select status from chore_turns where id = current_turn_id) <> 'pending' then
    raise exception 'FAIL: defer must not complete anything — the turn stays pending';
  end if;

  -- OP should now hold whatever TP's next upcoming turn was/became.
  select id into op_future_turn_id from chore_turns
  where chore_id = '2b3b2b3b-2222-2222-2222-222222222222' and assignee_id = '2b3b2b3b-0000-0000-0000-000000000001'
    and id <> current_turn_id;
  if op_future_turn_id is null then raise exception 'FAIL: OP should hold a different, later turn after deferring'; end if;

  if (select count(*) from chore_advance_log where turn_id = current_turn_id and kind = 'defer') <> 1 then
    raise exception 'FAIL: defer_turn should log itself';
  end if;

  select count(*) into n_after from chore_turns where chore_id = '2b3b2b3b-2222-2222-2222-222222222222';
  if n_after < n_before then raise exception 'FAIL: defer should never remove a turn'; end if;
end $$;
\echo '  ok  defer_turn hands the current turn to the next person and takes their upcoming turn in exchange'

-- Only the assignee can defer their own turn.
select set_config('request.user_id', '2b3b2b3b-0000-0000-0000-000000000002', false);
do $$
declare other_turn uuid;
begin
  select id into other_turn from chore_turns
  where chore_id = '2b3b2b3b-2222-2222-2222-222222222222' and status = 'pending'
    and assignee_id <> '2b3b2b3b-0000-0000-0000-000000000002'
  order by turn_number limit 1;

  begin
    perform defer_turn(other_turn);
    raise exception 'FAIL: defer_turn should refuse someone who is not the assignee';
  exception when others then
    if sqlerrm not like '%your own turn%' then raise; end if;
  end;
end $$;
\echo '  ok  defer_turn refuses to act on someone else''s turn'

-- Standing chores are excluded outright.
select set_config('request.user_id', '2b3b2b3b-0000-0000-0000-000000000001', false);
do $$
declare standing_turn uuid;
begin
  select id into standing_turn from chore_turns
  where chore_id = '2b3b2b3b-3333-3333-3333-333333333333' and status = 'pending';

  begin
    perform defer_turn(standing_turn);
    raise exception 'FAIL: defer_turn should refuse a standing chore';
  exception when others then
    if sqlerrm not like '%standing chores%' then raise; end if;
  end;
end $$;
\echo '  ok  defer_turn refuses standing chores'
