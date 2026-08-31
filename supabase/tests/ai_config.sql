\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data)
values ('eaaaaaaa-0000-0000-0000-000000000001','admin@aitest.com','{"name":"Ivy Admin"}');

do $$
begin
  perform set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000001', false);
  perform create_household('AI Config Test House', null, 'America/Detroit', 'Ivy Admin', 'IA');
end $$;

insert into auth.users (id, email, raw_user_meta_data)
values ('eaaaaaaa-0000-0000-0000-000000000002','member@aitest.com','{"name":"Amy Member"}');

do $$
declare c text;
begin
  perform set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000001', false);
  select code into c from (select (create_invite()).code) x;

  perform set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000002', false);
  perform redeem_invite(c, 'Amy Member', 'AM');
end $$;

-- ---------------------------------------------------------------- set + read

do $$
declare
  summary_provider text;
  decrypted text;
begin
  perform set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000001', false);

  perform set_ai_config('anthropic', 'sk-test-abc123', 'correct-secret');

  select provider into summary_provider from get_ai_config_summary();
  if summary_provider <> 'anthropic' then
    raise exception 'FAIL: get_ai_config_summary did not report the provider, got %', summary_provider;
  end if;

  -- Any member of the household (not just the admin) can read the summary —
  -- it never carries the key, so this is safe.
  perform set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000002', false);
  if not exists (select 1 from get_ai_config_summary()) then
    raise exception 'FAIL: a household member could not read the AI config summary';
  end if;

  perform set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000001', false);
  select api_key into decrypted from get_ai_credentials('correct-secret');
  if decrypted <> 'sk-test-abc123' then
    raise exception 'FAIL: get_ai_credentials did not decrypt back to the original key';
  end if;

  begin
    perform api_key from get_ai_credentials('wrong-secret');
    raise exception 'FAIL: get_ai_credentials decrypted with the wrong secret';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  an admin can set a provider + key; it decrypts only with the right secret'

-- -------------------------------------------------------------- validation

do $$
begin
  perform set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000001', false);

  begin
    perform set_ai_config('openai', 'sk-whatever', 'correct-secret');
    raise exception 'FAIL: set_ai_config accepted an unsupported provider';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    perform set_ai_config('gemini', '', 'correct-secret');
    raise exception 'FAIL: set_ai_config accepted an empty API key';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  perform set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000002', false);
  begin
    perform set_ai_config('anthropic', 'sk-hijack', 'correct-secret');
    raise exception 'FAIL: a non-admin set the household AI config';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  set_ai_config rejects unknown providers, empty keys, and non-admins'

-- ------------------------------------------------------------------- RLS

-- The whole point: not even this household's own admin can select the raw
-- ciphertext through a normal query — only the SECURITY DEFINER functions can.
set role domestic_app;
select set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000001', false);

do $$
begin
  if (select count(*) from household_ai_config) <> 0 then
    raise exception 'FAIL: an admin could read household_ai_config directly — RLS has no policy and should deny everyone';
  end if;
end $$;
\echo '  ok  household_ai_config is unreadable through any direct query, even for its own admin'

reset role;

-- ----------------------------------------------------------------- clear

do $$
begin
  perform set_config('request.user_id', 'eaaaaaaa-0000-0000-0000-000000000001', false);
  perform clear_ai_config();
  if exists (select 1 from get_ai_config_summary()) then
    raise exception 'FAIL: clear_ai_config did not remove the row';
  end if;
end $$;
\echo '  ok  clear_ai_config removes the stored key'
