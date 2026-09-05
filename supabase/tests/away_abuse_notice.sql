\set ON_ERROR_STOP on

-- get_away_abuse_flags/set_chore_away_override/dismiss_away_flag/admin_clear_away
-- (0035) — detects a person's turn getting bypassed by away across several
-- *separate* away periods on one chore, without ever auto-enforcing anything.

insert into households (id, name, timezone)
values ('8a8a8a8a-8a8a-8a8a-8a8a-8a8a8a8a8a8a', 'Away Abuse Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('8a8a8a8a-0000-0000-0000-000000000001','op@awayabuse.com','{"full_name":"One Person","initials":"OP","household_id":"8a8a8a8a-8a8a-8a8a-8a8a-8a8a8a8a8a8a"}'),
 ('8a8a8a8a-0000-0000-0000-000000000002','tp@awayabuse.com','{"full_name":"Two Person","initials":"TP","household_id":"8a8a8a8a-8a8a-8a8a-8a8a-8a8a8a8a8a8a"}');

update profiles set is_admin = true
 where household_id = '8a8a8a8a-8a8a-8a8a-8a8a-8a8a8a8a8a8a' and initials = 'OP';

-- Household size is 2 (OP, TP), so the pattern cap is 2 separate incidents.
-- Trash4: on demand, rotation TP(0) > OP(1), so turn_number 0 naturally
-- belongs to TP — whoever's turn gets bypassed by away is the point here.
insert into chores (id, household_id, name, emoji, cadence, queue_depth)
values ('8a8a8a8a-1111-1111-1111-111111111111','8a8a8a8a-8a8a-8a8a-8a8a-8a8a8a8a8a8a',
        'Trash4','🗑️','on_demand',1);

insert into chore_rotation (chore_id, profile_id, position)
select '8a8a8a8a-1111-1111-1111-111111111111', id,
       case initials when 'TP' then 0 else 1 end
from profiles where household_id = '8a8a8a8a-8a8a-8a8a-8a8a-8a8a8a8a8a8a';

select top_up_queue('8a8a8a8a-1111-1111-1111-111111111111');

do $$
begin
  if (select p.initials from chore_turns t join profiles p on p.id = t.assignee_id
      where t.chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and t.status = 'pending') <> 'TP' then
    raise exception 'FAIL: setup — turn 0 should start with TP';
  end if;
end $$;
\echo '  ok  setup — Trash4''s only pending turn belongs to TP'

-- ---------------------------------------------- incident #1: TP marks away

select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000002', false);
select set_away();

do $$
declare owner text; n int;
begin
  select p.initials into owner from chore_turns t join profiles p on p.id = t.assignee_id
  where t.chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and t.status = 'pending';
  if owner <> 'OP' then raise exception 'FAIL: TP being away should bypass them, handing the turn to OP, got %', owner; end if;

  select count(distinct away_id) into n from chore_away_skips
   where chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and profile_id = '8a8a8a8a-0000-0000-0000-000000000002';
  if n <> 1 then raise exception 'FAIL: this should be TP''s first logged away-skip incident, got %', n; end if;
end $$;
\echo '  ok  marking away bypasses the away person and logs one incident'

select clear_away();

do $$
begin
  if (select p.initials from chore_turns t join profiles p on p.id = t.assignee_id
      where t.chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and t.status = 'pending') <> 'TP' then
    raise exception 'FAIL: clearing away should hand the turn straight back to TP, with no new incident';
  end if;
end $$;
\echo '  ok  clearing away hands the turn back without logging anything new'

-- household is below the cap (2 members) with only 1 incident so far — no flag yet.
select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000001', false);
do $$
begin
  if exists (select 1 from get_away_abuse_flags() where profile_id = '8a8a8a8a-0000-0000-0000-000000000002') then
    raise exception 'FAIL: one incident should not trip a 2-person household''s cap yet';
  end if;
end $$;
\echo '  ok  a single incident does not flag anything yet'

-- --------------------------------------- incident #2: TP marks away again

select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000002', false);
select set_away();

do $$
declare n int;
begin
  select count(distinct away_id) into n from chore_away_skips
   where chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and profile_id = '8a8a8a8a-0000-0000-0000-000000000002';
  if n <> 2 then raise exception 'FAIL: a second, separate away period should be a second incident, got %', n; end if;
end $$;
\echo '  ok  a second separate away period logs a second, distinct incident'

-- ------------------------------------------------------- the flag surfaces

-- Non-admin (TP) can't see the flags at all.
do $$
begin
  begin
    perform * from get_away_abuse_flags();
    raise exception 'FAIL: get_away_abuse_flags should refuse a non-admin';
  exception when others then
    if sqlerrm not like '%only an admin can see this%' then raise; end if;
  end;
end $$;
\echo '  ok  get_away_abuse_flags refuses a non-admin'

select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000001', false);

do $$
declare rec record;
begin
  select * into rec from get_away_abuse_flags()
   where chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and profile_id = '8a8a8a8a-0000-0000-0000-000000000002';
  if not found then raise exception 'FAIL: two separate incidents should now flag TP on Trash4'; end if;
  if rec.incident_count <> 2 then raise exception 'FAIL: expected incident_count 2, got %', rec.incident_count; end if;
end $$;
\echo '  ok  the pattern shows up for an admin once incidents reach the household size'

-- --------------------------------------------------------- dismiss, no-op

select dismiss_away_flag('8a8a8a8a-1111-1111-1111-111111111111', '8a8a8a8a-0000-0000-0000-000000000002');

do $$
begin
  if exists (select 1 from get_away_abuse_flags() where profile_id = '8a8a8a8a-0000-0000-0000-000000000002') then
    raise exception 'FAIL: dismissing should hide the flag until more incidents accrue';
  end if;
end $$;
\echo '  ok  dismiss_away_flag hides the flag without changing any rotation behavior'

-- clear the still-active period #2 so the setup below starts clean.
select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000002', false);
select clear_away();

-- ----------------------------------------------------- enforce the override

select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000001', false);
select set_chore_away_override('8a8a8a8a-1111-1111-1111-111111111111', '8a8a8a8a-0000-0000-0000-000000000002', true);

select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000002', false);
select set_away();

do $$
declare owner text; n int;
begin
  select p.initials into owner from chore_turns t join profiles p on p.id = t.assignee_id
  where t.chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and t.status = 'pending';
  if owner <> 'TP' then
    raise exception 'FAIL: once enforced, away should no longer bypass TP on this chore, got %', owner;
  end if;

  select count(distinct away_id) into n from chore_away_skips
   where chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and profile_id = '8a8a8a8a-0000-0000-0000-000000000002';
  if n <> 2 then raise exception 'FAIL: an enforced override should not log a new incident, still expected 2, got %', n; end if;
end $$;
\echo '  ok  set_chore_away_override(true) stops away from bypassing that person on this chore'

-- ------------------------------------------------------- un-enforce it again

select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000001', false);
select set_chore_away_override('8a8a8a8a-1111-1111-1111-111111111111', '8a8a8a8a-0000-0000-0000-000000000002', false);

do $$
declare owner text; n int;
begin
  select p.initials into owner from chore_turns t join profiles p on p.id = t.assignee_id
  where t.chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and t.status = 'pending';
  if owner <> 'OP' then
    raise exception 'FAIL: un-enforcing while still away should let away bypass TP again, got %', owner;
  end if;

  select count(distinct away_id) into n from chore_away_skips
   where chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and profile_id = '8a8a8a8a-0000-0000-0000-000000000002';
  if n <> 3 then raise exception 'FAIL: this ongoing away period should count as a third, new incident, got %', n; end if;
end $$;
\echo '  ok  un-enforcing lets away bypass them again, and this ongoing period counts as a new incident'

-- Non-admin can't flip the override or dismiss a flag either.
select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000002', false);
do $$
begin
  begin
    perform set_chore_away_override('8a8a8a8a-1111-1111-1111-111111111111', '8a8a8a8a-0000-0000-0000-000000000002', true);
    raise exception 'FAIL: set_chore_away_override should refuse a non-admin';
  exception when others then
    if sqlerrm not like '%only an admin can change this%' then raise; end if;
  end;

  begin
    perform dismiss_away_flag('8a8a8a8a-1111-1111-1111-111111111111', '8a8a8a8a-0000-0000-0000-000000000002');
    raise exception 'FAIL: dismiss_away_flag should refuse a non-admin';
  exception when others then
    if sqlerrm not like '%only an admin can change this%' then raise; end if;
  end;
end $$;
\echo '  ok  set_chore_away_override and dismiss_away_flag both refuse a non-admin'

-- --------------------------------------------- completing resets the slate

select clear_away();

do $$
begin
  if (select p.initials from chore_turns t join profiles p on p.id = t.assignee_id
      where t.chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and t.status = 'pending') <> 'TP' then
    raise exception 'FAIL: setup — the turn should be back with TP before completing it';
  end if;
end $$;

do $$
declare the_turn uuid; n int;
begin
  select id into the_turn from chore_turns
  where chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and status = 'pending';

  perform complete_turn(the_turn, 'done');

  select count(*) into n from chore_away_skips
   where chore_id = '8a8a8a8a-1111-1111-1111-111111111111' and profile_id = '8a8a8a8a-0000-0000-0000-000000000002';
  if n <> 0 then raise exception 'FAIL: completing the turn should wipe TP''s logged incidents for this chore, got %', n; end if;
end $$;
\echo '  ok  completing a turn wipes that chore''s logged away-skip incidents for the assignee'

-- --------------------------------------------------------- admin_clear_away

select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000002', false);
select set_away();

do $$
begin
  if not (select exists (
    select 1 from member_away
    where profile_id = '8a8a8a8a-0000-0000-0000-000000000002'
      and starts_at <= now() and (ends_at is null or now() < ends_at)
  )) then
    raise exception 'FAIL: setup — TP should be away before the admin clears it';
  end if;
end $$;

-- A non-admin can't clear someone else's away status.
do $$
begin
  begin
    perform admin_clear_away('8a8a8a8a-0000-0000-0000-000000000002');
    raise exception 'FAIL: admin_clear_away should refuse a non-admin';
  exception when others then
    if sqlerrm not like '%only an admin can change this%' then raise; end if;
  end;
end $$;
\echo '  ok  admin_clear_away refuses a non-admin'

select set_config('request.user_id', '8a8a8a8a-0000-0000-0000-000000000001', false);
select admin_clear_away('8a8a8a8a-0000-0000-0000-000000000002');

do $$
begin
  if is_away_at('8a8a8a8a-0000-0000-0000-000000000002') then
    raise exception 'FAIL: admin_clear_away should end TP''s away status';
  end if;
end $$;
\echo '  ok  an admin can clear another member''s away status directly'
