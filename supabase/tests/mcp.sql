\set ON_ERROR_STOP on

-- Two people in one house, and a third person in a different one.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ec000000-0000-0000-0000-000000000001','ana@mcptest.com','{"name":"Ana"}'),
  ('ec000000-0000-0000-0000-000000000002','ben@mcptest.com','{"name":"Ben"}'),
  ('ec000000-0000-0000-0000-000000000003','cy@mcptest.com','{"name":"Cy"}');

do $$
declare c text;
begin
  perform set_config('request.user_id', 'ec000000-0000-0000-0000-000000000001', false);
  perform create_household('MCP House', null, 'America/Detroit', 'Ana', 'AN');
  select code into c from (select (create_invite()).code) x;

  perform set_config('request.user_id', 'ec000000-0000-0000-0000-000000000002', false);
  perform redeem_invite(c, 'Ben', 'BE');

  perform set_config('request.user_id', 'ec000000-0000-0000-0000-000000000003', false);
  perform create_household('Other House', null, 'America/Detroit', 'Cy', 'CY');
end $$;

-- ------------------------------------------------------------- rate limiting

do $$
declare r record; i int;
begin
  perform set_config('request.user_id', 'ec000000-0000-0000-0000-000000000001', false);

  -- A limit of 3 per window: the first three pass, the fourth does not.
  for i in 1..3 loop
    select * into r from mcp_rate_check('write', 3, 60);
    if not r.allowed then raise exception 'FAIL: call % should be within the limit', i; end if;
    if r.retry_after <> 0 then raise exception 'FAIL: an allowed call should have no retry_after'; end if;
  end loop;

  select * into r from mcp_rate_check('write', 3, 60);
  if r.allowed then raise exception 'FAIL: the fourth call should be refused'; end if;
  if r.retry_after < 1 or r.retry_after > 60 then
    raise exception 'FAIL: retry_after should fall inside the window, got %', r.retry_after;
  end if;

  -- Buckets are independent of each other.
  select * into r from mcp_rate_check('read', 3, 60);
  if not r.allowed then raise exception 'FAIL: the read bucket should be untouched by writes'; end if;

  -- And so are people.
  perform set_config('request.user_id', 'ec000000-0000-0000-0000-000000000002', false);
  select * into r from mcp_rate_check('write', 3, 60);
  if not r.allowed then raise exception 'FAIL: another person should have their own allowance'; end if;

  raise notice 'ok  rate limit counts per person and per bucket';
end $$;

do $$
begin
  perform set_config('request.user_id', 'ec000000-0000-0000-0000-000000000001', false);

  begin
    perform * from mcp_rate_check('invented', 5, 60);
    raise exception 'FAIL: an unknown bucket should be rejected';
  exception when others then
    if sqlerrm not like 'unknown rate limit bucket%' then raise; end if;
  end;

  begin
    perform * from mcp_rate_check('write', 0, 60);
    raise exception 'FAIL: a zero limit should be rejected';
  exception when others then
    if sqlerrm <> 'invalid rate limit' then raise; end if;
  end;

  begin
    perform * from mcp_rate_check('write', 5, 999999);
    raise exception 'FAIL: an enormous window should be rejected';
  exception when others then
    if sqlerrm <> 'invalid rate limit' then raise; end if;
  end;

  perform set_config('request.user_id', '', false);
  begin
    perform * from mcp_rate_check('read', 5, 60);
    raise exception 'FAIL: a signed-out caller should be rejected';
  exception when others then
    if sqlerrm <> 'not signed in' then raise; end if;
  end;

  raise notice 'ok  rate limit rejects unknown buckets, bad limits and signed-out callers';
end $$;

do $$
declare gone int; left_over int;
begin
  insert into mcp_rate_limits (profile_id, bucket, window_start, hits)
  values ('ec000000-0000-0000-0000-000000000001', 'read', now() - interval '3 days', 9);

  select prune_mcp_rate_limits() into gone;
  if gone <> 1 then raise exception 'FAIL: expected to prune exactly the stale window, pruned %', gone; end if;

  select count(*) into left_over from mcp_rate_limits;
  if left_over = 0 then raise exception 'FAIL: pruning must keep current windows'; end if;

  raise notice 'ok  pruning removes only stale windows';
end $$;

-- ------------------------------------------------------------- create_expense

do $$
declare
  ana constant uuid := 'ec000000-0000-0000-0000-000000000001';
  ben constant uuid := 'ec000000-0000-0000-0000-000000000002';
  cy  constant uuid := 'ec000000-0000-0000-0000-000000000003';
  e expenses;
  n int; total bigint; ana_net bigint; ben_net bigint; logged text;
begin
  perform set_config('request.user_id', ana::text, false);

  -- $40.03 split two ways leaves a remainder cent: 2002 + 2001.
  e := create_expense('Groceries', 4003, ana, current_date, 'equal',
    jsonb_build_array(
      jsonb_build_object('profile_id', ana, 'owed_cents', 2002, 'weight', null),
      jsonb_build_object('profile_id', ben, 'owed_cents', 2001, 'weight', null)),
    'groceries', 'weekly run');

  if e.amount_cents <> 4003 or e.split_kind <> 'equal' or e.category <> 'groceries' then
    raise exception 'FAIL: create_expense returned the wrong row: %', e;
  end if;

  select count(*), sum(owed_cents) into n, total from expense_splits where expense_id = e.id;
  if n <> 2 or total <> 4003 then
    raise exception 'FAIL: splits should be two rows adding to the total, got % rows / %', n, total;
  end if;

  -- Ana paid it all and owes 2002, so she is up 2001; Ben owes 2001.
  select net_cents into ana_net from v_balances where profile_id = ana;
  select net_cents into ben_net from v_balances where profile_id = ben;
  if ana_net <> 2001 or ben_net <> -2001 then
    raise exception 'FAIL: balances should be +2001/-2001, got %/%', ana_net, ben_net;
  end if;

  select summary into logged from activity_log
   where metadata ->> 'expense_id' = e.id::text and verb = 'added_expense';
  if logged is distinct from 'Ana added Groceries — $40.03' then
    raise exception 'FAIL: unexpected activity entry: %', logged;
  end if;

  raise notice 'ok  create_expense writes the expense, its splits and the activity entry together';
end $$;

-- Every refusal must leave nothing behind.
do $$
declare
  ana constant uuid := 'ec000000-0000-0000-0000-000000000001';
  ben constant uuid := 'ec000000-0000-0000-0000-000000000002';
  cy  constant uuid := 'ec000000-0000-0000-0000-000000000003';
  before_count int; after_count int;
  halves jsonb := jsonb_build_array(
    jsonb_build_object('profile_id', ana, 'owed_cents', 500, 'weight', null),
    jsonb_build_object('profile_id', ben, 'owed_cents', 500, 'weight', null));
begin
  perform set_config('request.user_id', ana::text, false);
  select count(*) into before_count from expenses;

  begin
    perform create_expense('Bad sum', 1001, ana, current_date, 'equal', halves);
    raise exception 'FAIL: shares that miss the total should be refused';
  exception when others then
    if sqlerrm <> 'the shares must add up to the total' then raise; end if;
  end;

  begin
    perform create_expense('Zero', 0, ana, current_date, 'equal', halves);
    raise exception 'FAIL: a zero amount should be refused';
  exception when others then
    if sqlerrm <> 'the amount must be greater than zero' then raise; end if;
  end;

  begin
    perform create_expense('  ', 1000, ana, current_date, 'equal', halves);
    raise exception 'FAIL: a blank description should be refused';
  exception when others then
    if sqlerrm <> 'give it a name' then raise; end if;
  end;

  begin
    perform create_expense('Outsider pays', 1000, cy, current_date, 'equal', halves);
    raise exception 'FAIL: a payer from another house should be refused';
  exception when others then
    if sqlerrm <> 'the payer must be in your household' then raise; end if;
  end;

  begin
    perform create_expense('Outsider owes', 1000, ana, current_date, 'equal',
      jsonb_build_array(
        jsonb_build_object('profile_id', ana, 'owed_cents', 500, 'weight', null),
        jsonb_build_object('profile_id', cy, 'owed_cents', 500, 'weight', null)));
    raise exception 'FAIL: a share for someone in another house should be refused';
  exception when others then
    if sqlerrm <> 'everyone in the split must be in your household' then raise; end if;
  end;

  begin
    perform create_expense('Twice', 1000, ana, current_date, 'equal',
      jsonb_build_array(
        jsonb_build_object('profile_id', ana, 'owed_cents', 500, 'weight', null),
        jsonb_build_object('profile_id', ana, 'owed_cents', 500, 'weight', null)));
    raise exception 'FAIL: the same person twice should be refused';
  exception when others then
    if sqlerrm <> 'each person can only appear once in the split' then raise; end if;
  end;

  begin
    perform create_expense('Negative', 1000, ana, current_date, 'equal',
      jsonb_build_array(
        jsonb_build_object('profile_id', ana, 'owed_cents', 1500, 'weight', null),
        jsonb_build_object('profile_id', ben, 'owed_cents', -500, 'weight', null)));
    raise exception 'FAIL: a negative share should be refused';
  exception when others then
    if sqlerrm <> 'no one can owe a negative share' then raise; end if;
  end;

  begin
    perform create_expense('Itemized', 1000, ana, current_date, 'itemized', halves);
    raise exception 'FAIL: itemized is not a plain split kind';
  exception when others then
    if sqlerrm not like 'unknown split kind%' then raise; end if;
  end;

  begin
    perform create_expense('Nobody', 1000, ana, current_date, 'equal', '[]'::jsonb);
    raise exception 'FAIL: an empty split should be refused';
  exception when others then
    if sqlerrm <> 'split it with someone' then raise; end if;
  end;

  select count(*) into after_count from expenses;
  if after_count <> before_count then
    raise exception 'FAIL: refused expenses must not leave rows behind (% -> %)', before_count, after_count;
  end if;

  -- Someone with no household cannot create one at all.
  insert into auth.users (id, email, raw_user_meta_data)
  values ('ec000000-0000-0000-0000-000000000009','lost@mcptest.com','{"name":"Lost"}');
  perform set_config('request.user_id', 'ec000000-0000-0000-0000-000000000009', false);
  begin
    perform create_expense('No house', 1000, ana, current_date, 'equal', halves);
    raise exception 'FAIL: a person without a household should be refused';
  exception when others then
    if sqlerrm <> 'you are not in a household' then raise; end if;
  end;

  raise notice 'ok  create_expense refuses every bad input and leaves nothing behind';
end $$;
