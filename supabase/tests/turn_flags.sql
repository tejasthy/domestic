\set ON_ERROR_STOP on

-- flag_on_demand/kiosk_flag_chore extended to standing chores (0028) —
-- supersedes the per-person flag_turn/clear_flag mechanism 0022 originally
-- added and 0028 removed. Standing chores stamp flagged_at instead of
-- due_at, since they have no due date and are already always visible.

insert into households (id, name, timezone)
values ('1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a', 'Flag Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('1a2a1a2a-0000-0000-0000-000000000001','op@flags.com','{"full_name":"One Person","initials":"OP","household_id":"1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a"}'),
 ('1a2a1a2a-0000-0000-0000-000000000002','tp@flags.com','{"full_name":"Two Person","initials":"TP","household_id":"1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a"}');

-- Dishes: on demand, queue of 1, rotation OP > TP.
insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('1a2a1a2a-1111-1111-1111-111111111111','1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a',
        'Dishes','🍽️','on_demand',1);

insert into chore_rotation (chore_id, profile_id, position)
select '1a2a1a2a-1111-1111-1111-111111111111', id,
       case initials when 'OP' then 0 else 1 end
from profiles where household_id = '1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a';

-- Recycling: standing, rotation OP > TP.
insert into chores (id, household_id, name, emoji, cadence)
values ('1a2a1a2a-2222-2222-2222-222222222222','1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a',
        'Recycling','♻️','standing');

insert into chore_rotation (chore_id, profile_id, position)
select '1a2a1a2a-2222-2222-2222-222222222222', id,
       case initials when 'OP' then 0 else 1 end
from profiles where household_id = '1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a';

-- Trash2: scheduled, to confirm flagging is refused outright for this cadence.
insert into chores (id, household_id, name, emoji, cadence, days_of_week)
values ('1a2a1a2a-3333-3333-3333-333333333333','1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a',
        'Trash2','🗑️','scheduled','{0,1,2,3,4,5,6}');

insert into chore_rotation (chore_id, profile_id, position)
select '1a2a1a2a-3333-3333-3333-333333333333', id, 0
from profiles where household_id = '1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a' and initials = 'OP';

select top_up_queue('1a2a1a2a-1111-1111-1111-111111111111');
select top_up_queue('1a2a1a2a-2222-2222-2222-222222222222');
select materialize_schedule('1a2a1a2a-3333-3333-3333-333333333333');

select set_config('request.user_id', '1a2a1a2a-0000-0000-0000-000000000001', false);

-- ------------------------------------------------------- on_demand (unchanged)

do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '1a2a1a2a-1111-1111-1111-111111111111' and status = 'pending';

  perform flag_on_demand('1a2a1a2a-1111-1111-1111-111111111111');

  if (select due_at from chore_turns where id = the_turn) is null then
    raise exception 'FAIL: flag_on_demand should still stamp due_at for an on_demand chore';
  end if;
  if (select flagged_at from chore_turns where id = the_turn) is not null then
    raise exception 'FAIL: flag_on_demand should not touch flagged_at for an on_demand chore';
  end if;
  if (select count(*) from activity_log where verb = 'flagged_chore') <> 1 then
    raise exception 'FAIL: flagging did not write an activity entry';
  end if;
end $$;
\echo '  ok  flag_on_demand still stamps due_at for on_demand chores, unchanged'

-- ------------------------------------------------------------------ standing

do $$
declare the_turn uuid; owner text;
begin
  select id into the_turn from chore_turns
  where chore_id = '1a2a1a2a-2222-2222-2222-222222222222' and status = 'pending';

  select p.initials into owner from chore_turns t join profiles p on p.id = t.assignee_id
  where t.id = the_turn;
  if owner <> 'OP' then raise exception 'FAIL: setup — turn should belong to OP'; end if;

  perform flag_on_demand('1a2a1a2a-2222-2222-2222-222222222222');

  if (select flagged_at from chore_turns where id = the_turn) is null then
    raise exception 'FAIL: flag_on_demand should stamp flagged_at for a standing chore';
  end if;
  if (select due_at from chore_turns where id = the_turn) is not null then
    raise exception 'FAIL: flag_on_demand must not invent a due date for a standing chore';
  end if;
  -- the turn is still OP's — flagging never reassigns anyone.
  select p.initials into owner from chore_turns t join profiles p on p.id = t.assignee_id
  where t.id = the_turn;
  if owner <> 'OP' then raise exception 'FAIL: flagging a standing chore must not change the assignee'; end if;
end $$;
\echo '  ok  flag_on_demand stamps flagged_at (not due_at) for a standing chore, without reassigning it'

-- Completing the flagged turn hands the baton on; the new turn starts unflagged.
do $$
declare next_turn uuid;
begin
  perform complete_turn((select id from chore_turns
    where chore_id = '1a2a1a2a-2222-2222-2222-222222222222' and status = 'pending'));

  select id into next_turn from chore_turns
  where chore_id = '1a2a1a2a-2222-2222-2222-222222222222' and status = 'pending';

  if (select flagged_at from chore_turns where id = next_turn) is not null then
    raise exception 'FAIL: the next standing turn should start unflagged';
  end if;
end $$;
\echo '  ok  completing a flagged standing turn hands off to a fresh, unflagged turn'

-- Flagging is refused outright for a scheduled chore.
do $$
begin
  begin
    perform flag_on_demand('1a2a1a2a-3333-3333-3333-333333333333');
    raise exception 'FAIL: flag_on_demand should refuse a scheduled chore';
  exception when others then
    if sqlerrm not like '%cannot be flagged%' then raise; end if;
  end;
end $$;
\echo '  ok  flag_on_demand refuses a scheduled chore'

-- --------------------------------------------------------------------- kiosk

do $$
declare the_turn uuid;
begin
  select id into the_turn from chore_turns
  where chore_id = '1a2a1a2a-2222-2222-2222-222222222222' and status = 'pending';

  perform kiosk_flag_chore('1a2a1a2a-1a2a-1a2a-1a2a-1a2a1a2a1a2a',
                            '1a2a1a2a-2222-2222-2222-222222222222',
                            '1a2a1a2a-0000-0000-0000-000000000002');

  if (select flagged_at from chore_turns where id = the_turn) is null then
    raise exception 'FAIL: kiosk_flag_chore should stamp flagged_at for a standing chore';
  end if;
end $$;
\echo '  ok  kiosk_flag_chore mirrors flag_on_demand for a standing chore'
