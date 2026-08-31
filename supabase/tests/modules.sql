\set ON_ERROR_STOP on

-- A household that does not do chores together — only splits money.
insert into auth.users (id, email, raw_user_meta_data)
values ('88888888-0000-0000-0000-000000000001','solo@thirdhouse.com','{"name":"Mo Modular"}');

select set_config('request.user_id', '88888888-0000-0000-0000-000000000001', false);
select create_household('Money Only House', null, 'America/Detroit', 'Mo Modular', 'MM',
                        array['expenses']);

do $$
declare hh uuid; mods text[];
begin
  select household_id into hh from profiles where id='88888888-0000-0000-0000-000000000001';

  if (select count(*) from chores where household_id=hh) <> 0 then
    raise exception 'FAIL: chores were seeded into a household that disabled them';
  end if;

  mods := enabled_modules(hh);
  if not ('expenses' = any(mods)) then
    raise exception 'FAIL: expenses should be enabled, got %', mods;
  end if;
  if 'chores' = any(mods) then
    raise exception 'FAIL: chores should be off, got %', mods;
  end if;
end $$;
\echo '  ok  a household can launch with only the modules it wants'

-- Turning one back on later.
select set_module('chores', true);

do $$
declare hh uuid;
begin
  select household_id into hh from profiles where id='88888888-0000-0000-0000-000000000001';
  if not ('chores' = any(enabled_modules(hh))) then
    raise exception 'FAIL: set_module did not enable chores';
  end if;
end $$;
\echo '  ok  an admin can turn a module on after the fact'

select set_module('expenses', false);

do $$
declare hh uuid;
begin
  select household_id into hh from profiles where id='88888888-0000-0000-0000-000000000001';
  if 'expenses' = any(enabled_modules(hh)) then
    raise exception 'FAIL: set_module did not disable expenses';
  end if;
end $$;
\echo '  ok  and turn one off'

-- Non-admins cannot.
insert into auth.users (id, email, raw_user_meta_data)
values ('88888888-0000-0000-0000-000000000002','plus1@thirdhouse.com','{}');

do $$
declare c text;
begin
  perform set_config('request.user_id', '88888888-0000-0000-0000-000000000001', false);
  select code into c from (select (create_invite()).code) x;

  perform set_config('request.user_id', '88888888-0000-0000-0000-000000000002', false);
  perform redeem_invite(c, 'Plus One', 'P1');

  begin
    perform set_module('expenses', true);
    raise exception 'FAIL: a non-admin changed the household modules';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  only admins can change which modules a household runs'

-- A module shipped after a household was created defaults to on, with no backfill.
do $$
declare hh uuid;
begin
  select household_id into hh from profiles where id='99999999-0000-0000-0000-000000000001';
  delete from household_modules where household_id = hh and module = 'kiosk';
  if not ('kiosk' = any(enabled_modules(hh))) then
    raise exception 'FAIL: a module with no explicit row should fall back to the default';
  end if;
end $$;
\echo '  ok  newly shipped modules default on without a migration'
