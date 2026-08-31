\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- fixtures
insert into households (id, name, timezone)
values ('11111111-1111-1111-1111-111111111111', '526 Detroit St.', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('aaaaaaaa-0000-0000-0000-000000000001','ab@x.com','{"full_name":"Aiden Brooks","initials":"AB","household_id":"11111111-1111-1111-1111-111111111111"}'),
 ('bbbbbbbb-0000-0000-0000-000000000002','bk@x.com','{"full_name":"Brandon Kauten","initials":"BK","household_id":"11111111-1111-1111-1111-111111111111"}'),
 ('cccccccc-0000-0000-0000-000000000003','tt@x.com','{"full_name":"Tejas Thiyagarajan","initials":"TT","household_id":"11111111-1111-1111-1111-111111111111"}'),
 ('dddddddd-0000-0000-0000-000000000004','na@x.com','{"full_name":"Nolen Armstrong","initials":"NA","household_id":"11111111-1111-1111-1111-111111111111"}');

do $$
begin
  if (select count(*) from profiles) <> 4 then
    raise exception 'FAIL: handle_new_user trigger did not create 4 profiles (got %)',
      (select count(*) from profiles);
  end if;
  if (select count(*) from profiles where household_id is null) > 0 then
    raise exception 'FAIL: household_id did not come through user metadata';
  end if;
end $$;
\echo '  ok  auth.users trigger creates profiles in the household'

-- Floors: Sun + Fri, weekly, rotation AB > BK > TT > NA
insert into chores (id, household_id, name, emoji, cadence, days_of_week, interval_weeks, anchor_date, lookahead_days)
values ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',
        'Floors','🧹','scheduled','{0,5}',1, current_date, 21);

-- Microwave: Saturday, every other week
insert into chores (id, household_id, name, emoji, cadence, days_of_week, interval_weeks, anchor_date, lookahead_days)
values ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111',
        'Microwave','🍲','scheduled','{6}',2, date_trunc('week', current_date)::date, 56);

-- Dishes: on demand, queue of 4, rotation NA > AB > BK > TT
insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111',
        'Dishes','🍽️','on_demand',4);

insert into chore_rotation (chore_id, profile_id, position)
select '22222222-2222-2222-2222-222222222222', id,
       case initials when 'AB' then 0 when 'BK' then 1 when 'TT' then 2 else 3 end
from profiles;

insert into chore_rotation (chore_id, profile_id, position)
select '44444444-4444-4444-4444-444444444444', id,
       case initials when 'AB' then 0 when 'BK' then 1 when 'TT' then 2 else 3 end
from profiles;

insert into chore_rotation (chore_id, profile_id, position)
select '33333333-3333-3333-3333-333333333333', id,
       case initials when 'NA' then 0 when 'AB' then 1 when 'BK' then 2 else 3 end
from profiles;

-- --------------------------------------------------------- on-demand queue
select top_up_queue('33333333-3333-3333-3333-333333333333');

do $$
declare seq text;
begin
  if (select count(*) from chore_turns
      where chore_id='33333333-3333-3333-3333-333333333333' and status='pending') <> 4 then
    raise exception 'FAIL: queue depth should be 4, got %',
      (select count(*) from chore_turns where chore_id='33333333-3333-3333-3333-333333333333');
  end if;

  select string_agg(p.initials, ' ' order by t.turn_number) into seq
  from chore_turns t join profiles p on p.id = t.assignee_id
  where t.chore_id='33333333-3333-3333-3333-333333333333';

  if seq <> 'NA AB BK TT' then
    raise exception 'FAIL: queue order should be "NA AB BK TT", got "%"', seq;
  end if;
end $$;
\echo '  ok  on-demand queue fills 4 deep in printed rotation order'

-- ------------------------------------------------------ scheduled chores
select materialize_schedule('22222222-2222-2222-2222-222222222222');

do $$
declare bad int;
begin
  if (select count(*) from chore_turns where chore_id='22222222-2222-2222-2222-222222222222') < 5 then
    raise exception 'FAIL: 3 weeks of Sun+Fri should be >= 5 turns, got %',
      (select count(*) from chore_turns where chore_id='22222222-2222-2222-2222-222222222222');
  end if;

  -- every materialized turn must land on a Sunday or a Friday, local time
  select count(*) into bad
  from chore_turns
  where chore_id='22222222-2222-2222-2222-222222222222'
    and extract(dow from (due_at at time zone 'America/Detroit')) not in (0,5);
  if bad > 0 then
    raise exception 'FAIL: % Floors turns fell outside Sun/Fri', bad;
  end if;

  -- assignee must equal rotation[turn_number % 4] for every single turn
  select count(*) into bad
  from chore_turns t
  join chore_rotation r
    on r.chore_id = t.chore_id and r.position = (t.turn_number % 4)
  where t.chore_id='22222222-2222-2222-2222-222222222222'
    and t.assignee_id <> r.profile_id;
  if bad > 0 then
    raise exception 'FAIL: % turns assigned out of rotation order', bad;
  end if;
end $$;
\echo '  ok  scheduled turns land on Sun/Fri and follow the rotation exactly'

-- biweekly must skip alternate weeks, and stay on Saturday
do $$
declare wk_gap int; bad int;
begin
  select count(*) into bad
  from chore_turns
  where chore_id='44444444-4444-4444-4444-444444444444'
    and extract(dow from (due_at at time zone 'America/Detroit')) <> 6;
  if bad > 0 then raise exception 'FAIL: % Microwave turns were not Saturday', bad; end if;

  select min(gap) into wk_gap from (
    select (due_at::date - lag(due_at::date) over (order by due_at)) as gap
    from chore_turns where chore_id='44444444-4444-4444-4444-444444444444'
  ) g where gap is not null;

  if wk_gap is not null and wk_gap <> 14 then
    raise exception 'FAIL: biweekly gap should be 14 days, got %', wk_gap;
  end if;
end $$;
\echo '  ok  biweekly microwave stays 14 days apart, on Saturdays'

-- --------------------------------------------------------- complete a turn
select set_config('request.user_id', 'dddddddd-0000-0000-0000-000000000004', false);

do $$
declare first_turn uuid; next_who text;
begin
  select id into first_turn from chore_turns
  where chore_id='33333333-3333-3333-3333-333333333333' and status='pending'
  order by turn_number limit 1;

  perform complete_turn(first_turn, 'ran the dishwasher');

  if (select status from chore_turns where id=first_turn) <> 'done' then
    raise exception 'FAIL: turn was not marked done';
  end if;

  -- the queue must refill so somebody is always up
  if (select count(*) from chore_turns
      where chore_id='33333333-3333-3333-3333-333333333333' and status='pending') <> 4 then
    raise exception 'FAIL: queue did not refill after completion (got %)',
      (select count(*) from chore_turns
       where chore_id='33333333-3333-3333-3333-333333333333' and status='pending');
  end if;

  select p.initials into next_who
  from chore_turns t join profiles p on p.id=t.assignee_id
  where t.chore_id='33333333-3333-3333-3333-333333333333' and t.status='pending'
  order by t.turn_number limit 1;

  if next_who <> 'AB' then
    raise exception 'FAIL: after NA the next up should be AB, got %', next_who;
  end if;

  if (select count(*) from activity_log where verb='completed_chore') <> 1 then
    raise exception 'FAIL: completing a chore did not write an activity entry';
  end if;
end $$;
\echo '  ok  complete_turn advances the rotation and refills the queue'

-- ------------------------------------------------------------- money views
insert into expenses (id, household_id, description, amount_cents, paid_by, created_by)
values ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111',
        'Kroger', 4003, 'aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001');

-- $40.03 four ways: 1001/1001/1001/1000
insert into expense_splits (expense_id, profile_id, owed_cents)
select '55555555-5555-5555-5555-555555555555', id,
       case when initials = 'NA' then 1000 else 1001 end
from profiles;

do $$
declare ab_net bigint; total bigint;
begin
  select net_cents into ab_net from v_balances
  where profile_id='aaaaaaaa-0000-0000-0000-000000000001';

  -- AB paid 4003 and owes 1001 => is owed 3002
  if ab_net <> 3002 then raise exception 'FAIL: AB net should be 3002, got %', ab_net; end if;

  select sum(net_cents) into total from v_balances;
  if total <> 0 then raise exception 'FAIL: balances must sum to zero, got %', total; end if;
end $$;
\echo '  ok  v_balances nets correctly and sums to zero'

insert into settlements (household_id, from_profile, to_profile, amount_cents)
values ('11111111-1111-1111-1111-111111111111',
        'dddddddd-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001', 1000);

do $$
declare total bigint;
begin
  if (select net_cents from v_balances where profile_id='dddddddd-0000-0000-0000-000000000004') <> 0 then
    raise exception 'FAIL: NA paid their share back and should be square, got %',
      (select net_cents from v_balances where profile_id='dddddddd-0000-0000-0000-000000000004');
  end if;
  select sum(net_cents) into total from v_balances;
  if total <> 0 then raise exception 'FAIL: balances stopped summing to zero after a settlement'; end if;
end $$;
\echo '  ok  settlements clear a balance and keep the books at zero'

-- --------------------------------------------------------- chore stats view
do $$
begin
  if (select done_count from v_chore_stats
      where profile_id='dddddddd-0000-0000-0000-000000000004'
        and chore_id='33333333-3333-3333-3333-333333333333') <> 1 then
    raise exception 'FAIL: v_chore_stats did not count NA''s completed load';
  end if;
end $$;
\echo '  ok  v_chore_stats counts completed turns'

-- --------------------------------------------------- views honour caller RLS
do $$
declare opts text[];
begin
  select reloptions into opts from pg_class where relname = 'v_balances';
  if not (opts @> array['security_invoker=true']) then
    raise exception 'FAIL: v_balances reloptions is %, expected security_invoker=true', opts;
  end if;
  select reloptions into opts from pg_class where relname = 'v_chore_stats';
  if not (opts @> array['security_invoker=true']) then
    raise exception 'FAIL: v_chore_stats reloptions is %, expected security_invoker=true', opts;
  end if;
end $$;
\echo '  ok  views are security_invoker=true (the form the linter recognizes)'

-- ------------------------------------------------------------ invited signup
insert into household_invites (email, household_id, full_name, initials, color)
values ('newguy@x.com', '11111111-1111-1111-1111-111111111111', 'New Guy', 'NG', '#702082');

-- An OAuth signup: Google-shaped metadata, no household_id, different casing.
insert into auth.users (id, email, raw_user_meta_data)
values ('ffffffff-0000-0000-0000-000000000010', 'NewGuy@x.com',
        '{"name":"Google Display Name","picture":"https://example.com/a.jpg"}');

do $$
declare p profiles%rowtype;
begin
  select * into p from profiles where id='ffffffff-0000-0000-0000-000000000010';

  if p.household_id is null then
    raise exception 'FAIL: an invited OAuth signup did not land in the household';
  end if;
  if p.full_name <> 'New Guy' then
    raise exception 'FAIL: invite name should win over provider name, got %', p.full_name;
  end if;
  if p.initials <> 'NG' then
    raise exception 'FAIL: invite initials not applied, got %', p.initials;
  end if;
  if p.avatar_url is null then
    raise exception 'FAIL: Google picture was not carried onto the profile';
  end if;
end $$;
\echo '  ok  invited Google signup joins the household with the right identity'

-- An uninvited signup must land nowhere.
insert into auth.users (id, email, raw_user_meta_data)
values ('ffffffff-0000-0000-0000-000000000011', 'stranger@x.com', '{"name":"Stranger"}');

do $$
begin
  if (select household_id from profiles where id='ffffffff-0000-0000-0000-000000000011') is not null then
    raise exception 'FAIL: an uninvited signup was placed in a household';
  end if;
end $$;
\echo '  ok  an uninvited signup joins no household'
