\set ON_ERROR_STOP on

-- complete_turn/kiosk_complete_turn (0031): the activity feed credits the
-- turn's assignee, not whoever actually tapped the button — completed_by
-- still records the real actor either way.

insert into households (id, name, timezone, allow_member_cross_complete)
values ('5e5e5e5e-5e5e-5e5e-5e5e-5e5e5e5e5e5e', 'Credit Test House', 'America/Detroit', true);

insert into auth.users (id, email, raw_user_meta_data) values
 ('5e5e5e5e-0000-0000-0000-000000000001','op@credit.com','{"full_name":"One Person","initials":"OP","household_id":"5e5e5e5e-5e5e-5e5e-5e5e-5e5e5e5e5e5e"}'),
 ('5e5e5e5e-0000-0000-0000-000000000002','tp@credit.com','{"full_name":"Two Person","initials":"TP","household_id":"5e5e5e5e-5e5e-5e5e-5e5e-5e5e5e5e5e5e"}');

insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('5e5e5e5e-1111-1111-1111-111111111111','5e5e5e5e-5e5e-5e5e-5e5e-5e5e5e5e5e5e',
        'Dishes','🍽️','on_demand',1);

insert into chore_rotation (chore_id, profile_id, position)
select '5e5e5e5e-1111-1111-1111-111111111111', id, 0
from profiles where household_id = '5e5e5e5e-5e5e-5e5e-5e5e-5e5e5e5e5e5e' and initials = 'OP';

select top_up_queue('5e5e5e5e-1111-1111-1111-111111111111');

-- TP (not the assignee) completes OP's turn, via cross-complete.
select set_config('request.user_id', '5e5e5e5e-0000-0000-0000-000000000002', false);

do $$
declare the_turn uuid; entry record;
begin
  select id into the_turn from chore_turns
  where chore_id = '5e5e5e5e-1111-1111-1111-111111111111' and status = 'pending';

  perform complete_turn(the_turn);

  if (select completed_by from chore_turns where id = the_turn) <> '5e5e5e5e-0000-0000-0000-000000000002' then
    raise exception 'FAIL: completed_by should still record the real actor (TP)';
  end if;

  select actor_id, summary into entry from activity_log
   where verb = 'completed_chore' and (metadata->>'turn_id')::uuid = the_turn;

  if entry.actor_id <> '5e5e5e5e-0000-0000-0000-000000000001' then
    raise exception 'FAIL: the activity feed should credit the assignee (OP), not the actor (TP), got %', entry.actor_id;
  end if;
  if entry.summary <> 'One Person did Dishes' then
    raise exception 'FAIL: the summary should name the assignee, got: %', entry.summary;
  end if;
end $$;
\echo '  ok  complete_turn credits the assignee in the activity feed, not whoever cross-completed it'

-- Same fix, kiosk path (which has never checked allow_member_cross_complete
-- at all — the kiosk's "acting as" model is inherently cross-person).
do $$
declare the_turn uuid; entry record;
begin
  select id into the_turn from chore_turns
  where chore_id = '5e5e5e5e-1111-1111-1111-111111111111' and status = 'pending';

  perform kiosk_complete_turn('5e5e5e5e-5e5e-5e5e-5e5e-5e5e5e5e5e5e', the_turn,
                               '5e5e5e5e-0000-0000-0000-000000000002');

  select actor_id, summary into entry from activity_log
   where verb = 'completed_chore' and (metadata->>'turn_id')::uuid = the_turn;

  if entry.actor_id <> '5e5e5e5e-0000-0000-0000-000000000001' then
    raise exception 'FAIL: kiosk_complete_turn should also credit the assignee, got %', entry.actor_id;
  end if;
end $$;
\echo '  ok  kiosk_complete_turn credits the assignee in the activity feed too'
