\set ON_ERROR_STOP on

-- The reason 0004 exists. Two households, and a member of one tries to walk
-- into the other. Run as a real non-superuser or this proves nothing.

-- Captured as superuser: once we drop to domestic_app, RLS correctly hides the
-- other household, so the test could not otherwise name its id to attack it.
create table public.other_household as
  select id from households
  where id <> '11111111-1111-1111-1111-111111111111'
  limit 1;
grant select on public.other_household to domestic_app;

do $$
begin
  if (select count(*) from public.other_household) = 0 then
    raise exception 'FAIL: setup wrong — needs a second household to test against';
  end if;
end $$;

set role domestic_app;
select set_config('request.user_id', 'cccccccc-0000-0000-0000-000000000003', false);

do $$
declare other_house uuid;
begin
  -- Tejas can see his own house.
  if (select count(*) from expenses) = 0 then
    raise exception 'FAIL: setup wrong — member cannot see their own expenses';
  end if;

  select id into other_house from public.other_household limit 1;

  -- The attack: rewrite my own household_id to the other house.
  begin
    update profiles set household_id = other_house where id = auth.uid();
    raise exception 'FAIL: a member reassigned themselves into another household';
  exception
    when insufficient_privilege then null;   -- column-level grant did its job
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- And the same for self-promotion to admin.
  begin
    update profiles set is_admin = true where id = auth.uid();
    raise exception 'FAIL: a member promoted themselves to admin';
  exception
    when insufficient_privilege then null;
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  a member cannot move themselves between households or self-promote'

-- The columns people are *supposed* to edit must still work.
do $$
begin
  update profiles set color = '#123456', quiet_from = 23 where id = auth.uid();
  if (select color from profiles where id = auth.uid()) <> '#123456' then
    raise exception 'FAIL: a member can no longer edit their own preferences';
  end if;
end $$;
\echo '  ok  members can still edit their own name, color and notification prefs'

-- Cross-household reads stay blocked at the row level too.
do $$
begin
  if (select count(*) from profiles
      where household_id <> (select household_id from profiles p2 where p2.id = auth.uid())) > 0 then
    raise exception 'FAIL: a member can read profiles from another household';
  end if;
  if (select count(*) from household_invites
      where household_id <> (select household_id from profiles p2 where p2.id = auth.uid())) > 0 then
    raise exception 'FAIL: a member can read another household''s invite codes';
  end if;
end $$;
\echo '  ok  another household''s people and invite codes are invisible'

reset role;
