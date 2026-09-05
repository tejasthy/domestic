\set ON_ERROR_STOP on

insert into households (id, name, timezone)
values ('2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b', 'Get Ahead Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('2b3b2b3b-0000-0000-0000-000000000001','op@ahead.com','{"full_name":"One Person","initials":"OP","household_id":"2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b"}'),
 ('2b3b2b3b-0000-0000-0000-000000000002','tp@ahead.com','{"full_name":"Two Person","initials":"TP","household_id":"2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b"}'),
 ('2b3b2b3b-0000-0000-0000-000000000003','thp@ahead.com','{"full_name":"Three Person","initials":"3P","household_id":"2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b"}'),
 ('2b3b2b3b-0000-0000-0000-000000000004','fp@ahead.com','{"full_name":"Four Person","initials":"4P","household_id":"2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b"}');

-- Dishes2: on demand, queue of 3, rotation TP(0) > 3P(1) > OP(2). 4P is a
-- household member deliberately left out of this chore's rotation.
insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('2b3b2b3b-1111-1111-1111-111111111111','2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b',
        'Dishes2','🍽️','on_demand',3);

insert into chore_rotation (chore_id, profile_id, position)
select '2b3b2b3b-1111-1111-1111-111111111111', id,
       case initials when 'TP' then 0 when '3P' then 1 else 2 end
from profiles
where household_id = '2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b' and initials in ('TP','3P','OP');

-- Trash2: scheduled, every day, rotation OP(0) > TP(1) — always has a "next
-- matching date" so defer never runs out of room to push to.
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

select set_config('request.user_id', '2b3b2b3b-0000-0000-0000-000000000003', false);

-- OP's own turn (2) is already queued behind TP's and 3P's — get_ahead lets
-- OP do it before either of them, without touching TP's or 3P's turns.
select set_config('request.user_id', '2b3b2b3b-0000-0000-0000-000000000001', false);

do $$
declare target_turn uuid; owner text;
begin
  select id into target_turn from chore_turns
  where chore_id = '2b3b2b3b-1111-1111-1111-111111111111' and turn_number = 2;
  if target_turn is null then raise exception 'FAIL: setup — turn 2 should exist and belong to OP'; end if;

  perform get_ahead('2b3b2b3b-1111-1111-1111-111111111111');

  if (select status from chore_turns where id = target_turn) <> 'done' then
    raise exception 'FAIL: get_ahead should complete OP''s own queued turn';
  end if;
  if (select note from chore_turns where id = target_turn) <> 'Done ahead of schedule' then
    raise exception 'FAIL: get_ahead should leave its default note when none was given';
  end if;
  if (select count(*) from chore_advance_log where turn_id = target_turn and kind = 'get_ahead') <> 1 then
    raise exception 'FAIL: get_ahead should log itself';
  end if;

  -- TP's and 3P's turns are untouched — get_ahead never reassigns anyone else.
  select p.initials into owner from chore_turns t join profiles p on p.id = t.assignee_id
  where t.chore_id = '2b3b2b3b-1111-1111-1111-111111111111' and t.turn_number = 0;
  if owner <> 'TP' then raise exception 'FAIL: turn 0 should still belong to TP'; end if;

  -- The queue should be topped back up to its full depth (3), same as an
  -- ordinary completion would.
  if (select count(*) from chore_turns
      where chore_id = '2b3b2b3b-1111-1111-1111-111111111111' and status = 'pending') <> 3 then
    raise exception 'FAIL: get_ahead should top the queue back up to queue_depth';
  end if;
end $$;
\echo '  ok  get_ahead completes your own turn early without touching anyone else''s'

-- Default limit: 1 use per rolling 30 days.
do $$
begin
  begin
    perform get_ahead('2b3b2b3b-1111-1111-1111-111111111111');
    raise exception 'FAIL: get_ahead should refuse a second use inside 30 days';
  exception when others then
    if sqlerrm not like '%last 30 days%' then raise; end if;
  end;
end $$;
\echo '  ok  get_ahead enforces the default once-per-30-days limit'

-- Bump the household's limits so the "already N ahead" cap can be tested on
-- its own, without the 30-day cap getting in the way. No row exists for this
-- module yet ('get_ahead' isn't in default_modules()), so this must insert,
-- not just update. max_ahead is set to 1 — OP already has exactly one
-- get_ahead credit outstanding from the successful call above (turn 2 is
-- still beyond the chore's pending frontier), so this alone should already
-- be enough to block a further use, with 30-day uses to spare.
insert into household_modules (household_id, module, enabled, settings)
values ('2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b', 'get_ahead', true,
        '{"get_ahead":{"max_ahead":1,"max_per_30d":5},"defer":{"max_ahead":2,"max_per_30d":1}}'::jsonb)
on conflict (household_id, module) do update set enabled = excluded.enabled, settings = excluded.settings;

do $$
begin
  begin
    perform get_ahead('2b3b2b3b-1111-1111-1111-111111111111');
    raise exception 'FAIL: get_ahead should refuse once max_ahead is reached, even with 30-day uses to spare';
  exception when others then
    if sqlerrm not like '%already % turn(s) ahead%' then raise; end if;
  end;
end $$;
\echo '  ok  get_ahead enforces the "already N ahead" cap independently of the 30-day cap'

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

-- Back on, with generous limits, for the defer tests below.
insert into household_modules (household_id, module, enabled, settings)
values ('2b3b2b3b-2b3b-2b3b-2b3b-2b3b2b3b2b3b', 'get_ahead', true,
        '{"get_ahead":{"max_ahead":2,"max_per_30d":1},"defer":{"max_ahead":2,"max_per_30d":5}}'::jsonb)
on conflict (household_id, module) do update set enabled = excluded.enabled, settings = excluded.settings;

/* =================================================================== defer */

do $$
declare the_turn uuid; before_due timestamptz; after_due timestamptz;
begin
  select id, due_at into the_turn, before_due from chore_turns
  where chore_id = '2b3b2b3b-2222-2222-2222-222222222222' and status = 'pending'
    and assignee_id = '2b3b2b3b-0000-0000-0000-000000000001'
  order by turn_number limit 1;
  if the_turn is null then raise exception 'FAIL: setup — OP should have a pending Trash2 turn'; end if;

  perform defer_turn(the_turn);
  select due_at into after_due from chore_turns where id = the_turn;

  if after_due <= before_due then
    raise exception 'FAIL: defer_turn should push the due date later, not earlier or unchanged';
  end if;
  if (select status from chore_turns where id = the_turn) <> 'pending' then
    raise exception 'FAIL: defer_turn must leave the turn pending';
  end if;
  if (select count(*) from chore_advance_log where turn_id = the_turn and kind = 'defer') <> 1 then
    raise exception 'FAIL: defer_turn should log itself';
  end if;
end $$;
\echo '  ok  defer_turn pushes a scheduled turn''s due date to the next matching day'

-- Per-turn chain cap: this same turn can be deferred up to max_ahead (2)
-- times total; the third attempt on it must fail regardless of who owns it.
do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '2b3b2b3b-2222-2222-2222-222222222222' and status = 'pending'
    and assignee_id = '2b3b2b3b-0000-0000-0000-000000000001'
  order by turn_number limit 1;

  perform defer_turn(the_turn); -- second defer on the same turn: allowed (cap is 2)

  begin
    perform defer_turn(the_turn);
    raise exception 'FAIL: defer_turn should refuse a third defer on the same turn';
  exception when others then
    if sqlerrm not like '%already been deferred%' then raise; end if;
  end;
end $$;
\echo '  ok  defer_turn enforces the per-turn defer-chain cap'

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

-- A turn with no due date (unflagged on_demand, or a standing turn) can't be
-- deferred — there is nothing to push back.
select set_config('request.user_id', '2b3b2b3b-0000-0000-0000-000000000002', false);
do $$
declare no_due_turn uuid;
begin
  select id into no_due_turn from chore_turns
  where chore_id = '2b3b2b3b-1111-1111-1111-111111111111' and status = 'pending'
    and assignee_id = '2b3b2b3b-0000-0000-0000-000000000002' and due_at is null
  order by turn_number limit 1;
  if no_due_turn is null then raise exception 'FAIL: setup — TP should have an un-due on-demand turn'; end if;

  begin
    perform defer_turn(no_due_turn);
    raise exception 'FAIL: defer_turn should refuse a turn with no due date';
  exception when others then
    if sqlerrm not like '%no due date%' then raise; end if;
  end;
end $$;
\echo '  ok  defer_turn refuses a turn with no due date to push back'
