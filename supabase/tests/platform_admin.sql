\set ON_ERROR_STOP on

-- Same trick auth_shim.sql uses for request.user_id: fake the one-per-
-- deployment GUC a real install sets with `alter database ... set ...`.
select set_config('app.platform_admin_emails', 'admin@platform.com', false);

insert into households (id, name, timezone)
values ('4d5d4d5d-4d5d-4d5d-4d5d-4d5d4d5d4d5d', 'Platform Admin Test House', 'America/Detroit');

insert into auth.users (id, email, raw_user_meta_data) values
 ('4d5d4d5d-0000-0000-0000-000000000001','admin@platform.com','{"full_name":"Admin Person","initials":"AP","household_id":"4d5d4d5d-4d5d-4d5d-4d5d-4d5d4d5d4d5d"}'),
 ('4d5d4d5d-0000-0000-0000-000000000002','regular@platform.com','{"full_name":"Regular Person","initials":"RP","household_id":"4d5d4d5d-4d5d-4d5d-4d5d-4d5d4d5d4d5d"}');

-- --------------------------------------------------------------- identity

select set_config('request.user_id', '4d5d4d5d-0000-0000-0000-000000000001', false);
do $$
begin
  if not is_platform_admin() then
    raise exception 'FAIL: the profile whose email is in app.platform_admin_emails should be a platform admin';
  end if;
end $$;
\echo '  ok  is_platform_admin is true for an allow-listed email'

select set_config('request.user_id', '4d5d4d5d-0000-0000-0000-000000000002', false);
do $$
begin
  if is_platform_admin() then
    raise exception 'FAIL: an ordinary household member should not be a platform admin';
  end if;
end $$;
\echo '  ok  is_platform_admin is false for everyone else'

-- With the GUC entirely unset, nobody is a platform admin — safe by default
-- for a fresh deployment that never configured one.
select set_config('app.platform_admin_emails', '', false);
select set_config('request.user_id', '4d5d4d5d-0000-0000-0000-000000000001', false);
do $$
begin
  if is_platform_admin() then
    raise exception 'FAIL: an unset allowlist should mean nobody is a platform admin';
  end if;
end $$;
\echo '  ok  is_platform_admin is false for everyone when the GUC is unset'

select set_config('app.platform_admin_emails', 'admin@platform.com', false);

-- --------------------------------------------------------------- feedback

select set_config('request.user_id', '4d5d4d5d-0000-0000-0000-000000000002', false);
do $$
declare new_id uuid;
begin
  new_id := submit_feedback('bug', 'The kiosk clock is wrong.');
  if new_id is null then raise exception 'FAIL: submit_feedback should return a new id'; end if;
  if (select household_id from feedback_submissions where id = new_id)
     <> '4d5d4d5d-4d5d-4d5d-4d5d-4d5d4d5d4d5d' then
    raise exception 'FAIL: submit_feedback should stamp household_id from the caller, not trust a client value';
  end if;
end $$;
\echo '  ok  submit_feedback records a submission stamped from the caller''s session'

-- Feedback survives even with no household — someone hitting a bug before
-- finishing onboarding should still be able to report it.
do $$
declare orphan uuid := gen_random_uuid(); new_id uuid;
begin
  -- handle_new_user() already creates the matching profiles row (with a
  -- null household_id, since no invite metadata is given) on this insert.
  insert into auth.users (id, email) values (orphan, 'orphan@platform.com');
  perform set_config('request.user_id', orphan::text, false);

  new_id := submit_feedback('feature', 'Dark mode for the kiosk please.');
  if (select household_id from feedback_submissions where id = new_id) is not null then
    raise exception 'FAIL: a pre-household submitter should record a null household_id';
  end if;
end $$;
\echo '  ok  submit_feedback works before someone has joined a household'

-- A non-admin can't read the feedback inbox directly.
select set_config('request.user_id', '4d5d4d5d-0000-0000-0000-000000000002', false);
do $$
begin
  begin
    perform platform_feedback();
    raise exception 'FAIL: platform_feedback should refuse a non-platform-admin';
  exception when others then
    if sqlerrm not like '%not authorized%' then raise; end if;
  end;
end $$;
\echo '  ok  platform_feedback refuses a non-platform-admin'

-- The platform admin can, and sees the submitter's name attached.
select set_config('request.user_id', '4d5d4d5d-0000-0000-0000-000000000001', false);
do $$
declare row_count int;
begin
  select count(*) into row_count from platform_feedback();
  if row_count < 2 then
    raise exception 'FAIL: platform_feedback should see both submissions above (got %)', row_count;
  end if;
end $$;
\echo '  ok  platform_feedback lets the platform admin see submissions across households'

-- ----------------------------------------------------------- aggregate stats

do $$
declare stats_row record;
begin
  select * into stats_row from platform_stats();
  if stats_row.households_total < 1 then
    raise exception 'FAIL: platform_stats should count at least this test''s household';
  end if;
  if stats_row.feedback_total < 2 then
    raise exception 'FAIL: platform_stats should count the feedback submitted above';
  end if;
end $$;
\echo '  ok  platform_stats returns cross-household aggregate counts'

select set_config('request.user_id', '4d5d4d5d-0000-0000-0000-000000000002', false);
do $$
begin
  begin
    perform platform_stats();
    raise exception 'FAIL: platform_stats should refuse a non-platform-admin';
  exception when others then
    if sqlerrm not like '%not authorized%' then raise; end if;
  end;
end $$;
\echo '  ok  platform_stats refuses a non-platform-admin'

do $$
begin
  begin
    perform platform_households_summary();
    raise exception 'FAIL: platform_households_summary should refuse a non-platform-admin';
  exception when others then
    if sqlerrm not like '%not authorized%' then raise; end if;
  end;
end $$;
\echo '  ok  platform_households_summary refuses a non-platform-admin'
