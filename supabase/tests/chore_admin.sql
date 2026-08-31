\set ON_ERROR_STOP on

-- Fresh household so this file does not depend on state left by smoke.sql.
insert into auth.users (id, email, raw_user_meta_data)
values ('caaaaaaa-0000-0000-0000-000000000001','admin@choretest.com','{"name":"Ada Admin"}');

do $$
begin
  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000001', false);
  perform create_household('Chore Test House', null, 'America/Detroit', 'Ada Admin', 'AA');
end $$;

insert into auth.users (id, email, raw_user_meta_data)
values ('caaaaaaa-0000-0000-0000-000000000002','member@choretest.com','{"name":"Mia Member"}');

do $$
declare c text;
begin
  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000001', false);
  select code into c from (select (create_invite()).code) x;

  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000002', false);
  perform redeem_invite(c, 'Mia Member', 'MM');
end $$;

-- ------------------------------------------------------------------ create

do $$
declare
  hh uuid;
  new_id uuid;
  n int;
begin
  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000001', false);
  select household_id into hh from profiles where id = 'caaaaaaa-0000-0000-0000-000000000001';

  select (create_chore(
    p_name := 'Vacuum', p_cadence := 'scheduled', p_emoji := '🧹',
    p_description := 'Living room and hallway',
    p_days_of_week := '{1,4}'::smallint[], p_interval_weeks := 1::smallint,
    p_due_hour := 20::smallint, p_queue_depth := 4::smallint, p_lookahead_days := 21::smallint,
    p_profile_ids := array['caaaaaaa-0000-0000-0000-000000000001','caaaaaaa-0000-0000-0000-000000000002']::uuid[]
  )).id into new_id;

  if new_id is null then raise exception 'FAIL: create_chore did not return a row'; end if;
  if (select household_id from chores where id = new_id) is distinct from hh then
    raise exception 'FAIL: new chore was not attached to the caller''s household';
  end if;

  select count(*) into n from chore_rotation where chore_id = new_id;
  if n <> 2 then raise exception 'FAIL: expected a 2-person rotation, got %', n; end if;

  if (select position from chore_rotation
      where chore_id = new_id and profile_id = 'caaaaaaa-0000-0000-0000-000000000001') <> 0 then
    raise exception 'FAIL: first profile in the array should be position 0';
  end if;

  if not exists (select 1 from chore_turns where chore_id = new_id) then
    raise exception 'FAIL: a new scheduled chore should already have materialized turns';
  end if;

  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000002', false);
  begin
    perform create_chore('Sneaky chore', 'on_demand');
    raise exception 'FAIL: a non-admin created a chore';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  an admin can create a chore with an ordered rotation; a member cannot'

-- -------------------------------------------------------------------- edit

do $$
declare
  v_chore uuid;
  pending_before int;
  pending_after int;
begin
  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000001', false);
  select id into v_chore from chores where name = 'Vacuum';

  select count(*) into pending_before from chore_turns where chore_id = v_chore and status = 'pending';
  if pending_before = 0 then raise exception 'FAIL: setup wrong — no pending turns to invalidate'; end if;

  -- Switching cadence must drop the now-speculative pending turns and refill
  -- under the new cadence, without touching this chore's future rotation.
  perform update_chore(v_chore, p_cadence := 'on_demand'::chore_cadence, p_queue_depth := 3::smallint);

  if (select cadence from chores where id = v_chore) <> 'on_demand' then
    raise exception 'FAIL: update_chore did not change the cadence';
  end if;

  select count(*) into pending_after from chore_turns where chore_id = v_chore and status = 'pending';
  if pending_after <> 3 then
    raise exception 'FAIL: expected queue_depth=3 pending turns after the cadence flip, got %', pending_after;
  end if;

  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000002', false);
  begin
    perform update_chore(v_chore, p_name := 'Hijacked');
    raise exception 'FAIL: a non-admin edited a chore';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  editing a cadence-affecting field re-derives pending turns only'

-- --------------------------------------------------------------- active

do $$
declare
  v_chore uuid;
begin
  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000001', false);
  select id into v_chore from chores where name = 'Vacuum';

  perform set_chore_active(v_chore, false);
  if (select is_active from chores where id = v_chore) then
    raise exception 'FAIL: set_chore_active(false) did not deactivate';
  end if;
  if not exists (select 1 from chore_turns where chore_id = v_chore) then
    raise exception 'FAIL: deactivating a chore should not delete its turn history';
  end if;

  perform set_chore_active(v_chore, true);
  if not (select is_active from chores where id = v_chore) then
    raise exception 'FAIL: set_chore_active(true) did not reactivate';
  end if;

  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000002', false);
  begin
    perform set_chore_active(v_chore, false);
    raise exception 'FAIL: a non-admin deactivated a chore';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  deactivating a chore is reversible and keeps its history'

-- ------------------------------------------------------------- rotation

do $$
declare
  v_chore uuid;
  first_turn_number int;
  actual_assignee uuid;
  expected_assignee uuid;
begin
  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000001', false);
  select id into v_chore from chores where name = 'Vacuum';

  -- Reverse the two-person roster.
  perform set_chore_rotation(
    v_chore,
    array['caaaaaaa-0000-0000-0000-000000000002','caaaaaaa-0000-0000-0000-000000000001']::uuid[]
  );

  if (select position from chore_rotation
      where chore_id = v_chore and profile_id = 'caaaaaaa-0000-0000-0000-000000000002') <> 0 then
    raise exception 'FAIL: set_chore_rotation did not honor the new order';
  end if;

  -- Every pending turn must be re-derived from the new order, not left stale.
  select turn_number, assignee_id into first_turn_number, actual_assignee
    from chore_turns where chore_id = v_chore and status = 'pending'
   order by turn_number limit 1;
  expected_assignee := rotation_assignee(v_chore, first_turn_number);
  if actual_assignee is distinct from expected_assignee then
    raise exception 'FAIL: a pending turn was not resynced after the rotation changed';
  end if;

  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000002', false);
  begin
    perform set_chore_rotation(v_chore, array['caaaaaaa-0000-0000-0000-000000000002']::uuid[]);
    raise exception 'FAIL: a non-admin edited the rotation';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- Cannot smuggle someone from another household onto the roster.
  perform set_config('request.user_id', 'caaaaaaa-0000-0000-0000-000000000001', false);
  begin
    perform set_chore_rotation(v_chore, array['aaaaaaaa-0000-0000-0000-000000000001']::uuid[]);
    raise exception 'FAIL: set_chore_rotation accepted a profile from another household';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  set_chore_rotation reorders, resyncs pending turns, and stays in-household'
