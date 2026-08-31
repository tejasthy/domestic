\set ON_ERROR_STOP on

-- Ground truth, captured as superuser before we drop privileges — this is what
-- a household member *should* be able to see.
create table public.chores_unfiltered as
  select id from chores where household_id = '11111111-1111-1111-1111-111111111111';
create table public.profiles_unfiltered as
  select id from profiles where household_id = '11111111-1111-1111-1111-111111111111';
grant select on public.chores_unfiltered, public.profiles_unfiltered to domestic_app;

-- RLS is the security boundary, so it gets tested as a real non-superuser.
set role domestic_app;

-- Impersonate Tejas.
select set_config('request.user_id', 'cccccccc-0000-0000-0000-000000000003', false);

-- Counts are derived, not hardcoded, so adding fixtures upstream can't turn
-- this into a false failure.
do $$
declare visible int; expected int;
begin
  select count(*) into visible  from chores;
  select count(*) into expected from public.chores_unfiltered;
  if visible <> expected then
    raise exception 'FAIL: member saw % of % household chores', visible, expected;
  end if;

  select count(*) into visible  from profiles;
  select count(*) into expected from public.profiles_unfiltered;
  if visible <> expected then
    raise exception 'FAIL: member saw % of % roommates', visible, expected;
  end if;

  if (select count(*) from expenses) < 1 then
    raise exception 'FAIL: a member should see the household expense';
  end if;
end $$;
\echo '  ok  a signed-in roommate sees their household'

-- Now an authenticated user who belongs to no household.
select set_config('request.user_id', 'eeeeeeee-0000-0000-0000-000000000009', false);

do $$
begin
  if (select count(*) from chores) <> 0 then
    raise exception 'FAIL: an outsider saw % chores', (select count(*) from chores);
  end if;
  if (select count(*) from chore_turns) <> 0 then
    raise exception 'FAIL: an outsider saw chore turns';
  end if;
  if (select count(*) from expenses) <> 0 then
    raise exception 'FAIL: an outsider saw expenses';
  end if;
  if (select count(*) from v_balances) <> 0 then
    raise exception 'FAIL: an outsider read v_balances — security_invoker is not on';
  end if;
  if (select count(*) from activity_log) <> 0 then
    raise exception 'FAIL: an outsider read the activity log';
  end if;
  if (select count(*) from household_invites) <> 0 then
    raise exception 'FAIL: an outsider read the invite roster (it holds emails)';
  end if;
end $$;
\echo '  ok  an outsider sees nothing, views included'

-- And with no session at all (auth.uid() is null).
select set_config('request.user_id', '', false);

do $$
begin
  if (select count(*) from expenses) <> 0 then
    raise exception 'FAIL: anonymous read got through';
  end if;
end $$;
\echo '  ok  anonymous reads are blocked'

reset role;
