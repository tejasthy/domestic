\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data)
values ('deaaaaaa-0000-0000-0000-000000000001','admin@rectest.com','{"name":"Rae Admin"}');

do $$
begin
  perform set_config('request.user_id', 'deaaaaaa-0000-0000-0000-000000000001', false);
  perform create_household('Recurring Test House', null, 'America/Detroit', 'Rae Admin', 'RA');
end $$;

insert into auth.users (id, email, raw_user_meta_data)
values ('deaaaaaa-0000-0000-0000-000000000002','member@rectest.com','{"name":"Remy Member"}');

do $$
declare c text;
begin
  perform set_config('request.user_id', 'deaaaaaa-0000-0000-0000-000000000001', false);
  select code into c from (select (create_invite()).code) x;

  perform set_config('request.user_id', 'deaaaaaa-0000-0000-0000-000000000002', false);
  perform redeem_invite(c, 'Remy Member', 'RM');
end $$;

-- ------------------------------------------------------------------ create

do $$
declare
  hh uuid;
  new_id uuid;
  total bigint;
begin
  perform set_config('request.user_id', 'deaaaaaa-0000-0000-0000-000000000001', false);
  select household_id into hh from profiles where id = 'deaaaaaa-0000-0000-0000-000000000001';

  select (create_recurring_expense(
    'Rent', 200000, 'deaaaaaa-0000-0000-0000-000000000001', 'equal', 'monthly',
    jsonb_build_array(
      jsonb_build_object('profile_id','deaaaaaa-0000-0000-0000-000000000001','owed_cents',100000,'weight',null),
      jsonb_build_object('profile_id','deaaaaaa-0000-0000-0000-000000000002','owed_cents',100000,'weight',null)
    ),
    'household', 1::smallint, 1::smallint, 1::smallint, current_date
  )).id into new_id;

  if new_id is null then raise exception 'FAIL: create_recurring_expense did not return a row'; end if;
  if (select household_id from recurring_expenses where id = new_id) is distinct from hh then
    raise exception 'FAIL: new recurring expense was not attached to the caller''s household';
  end if;

  select sum(owed_cents) into total from recurring_expense_participants where recurring_expense_id = new_id;
  if total <> 200000 then raise exception 'FAIL: participant splits should sum to the total, got %', total; end if;

  -- Splits that do not add up must be rejected.
  begin
    perform create_recurring_expense(
      'Bad split', 5000, 'deaaaaaa-0000-0000-0000-000000000001', 'exact', 'weekly',
      jsonb_build_array(jsonb_build_object('profile_id','deaaaaaa-0000-0000-0000-000000000001','owed_cents',1000,'weight',null))
    );
    raise exception 'FAIL: create_recurring_expense accepted splits that do not sum to the total';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- Monthly with no day_of_month must be rejected.
  begin
    perform create_recurring_expense(
      'No day', 5000, 'deaaaaaa-0000-0000-0000-000000000001', 'equal', 'monthly',
      jsonb_build_array(jsonb_build_object('profile_id','deaaaaaa-0000-0000-0000-000000000001','owed_cents',5000,'weight',null))
    );
    raise exception 'FAIL: a monthly recurring expense was created without a day of the month';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  perform set_config('request.user_id', 'deaaaaaa-0000-0000-0000-000000000002', false);
  begin
    perform create_recurring_expense(
      'Sneaky', 100, 'deaaaaaa-0000-0000-0000-000000000002', 'equal', 'weekly',
      jsonb_build_array(jsonb_build_object('profile_id','deaaaaaa-0000-0000-0000-000000000002','owed_cents',100,'weight',null))
    );
    raise exception 'FAIL: a non-admin created a recurring expense';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  an admin can create a recurring expense; splits and cadence are validated; a member cannot'

-- ------------------------------------------------------------------ posting

-- Note: post_due_recurring_expenses() posts every due row in the database,
-- not just this test's own — 'Rent' from the previous block is also due
-- today (its next_run_on defaulted to current_date), so assertions here count
-- rows by description rather than the function's total returned row count.
do $$
declare
  weekly_id uuid;
  next1 date;
  next2 date;
  expense_count int;
  split_sum bigint;
begin
  perform set_config('request.user_id', 'deaaaaaa-0000-0000-0000-000000000001', false);

  -- 3 days overdue on a weekly cadence: exactly one catch-up occurrence
  -- (the next one, at +4 days, is still in the future).
  select (create_recurring_expense(
    'Streaming', 1000, 'deaaaaaa-0000-0000-0000-000000000001', 'equal', 'weekly',
    jsonb_build_array(
      jsonb_build_object('profile_id','deaaaaaa-0000-0000-0000-000000000001','owed_cents',500,'weight',null),
      jsonb_build_object('profile_id','deaaaaaa-0000-0000-0000-000000000002','owed_cents',500,'weight',null)
    ),
    'utilities', 1::smallint, 1::smallint, null, current_date - 3
  )).id into weekly_id;

  perform post_due_recurring_expenses();

  select next_run_on into next1 from recurring_expenses where id = weekly_id;
  if next1 <= current_date then
    raise exception 'FAIL: next_run_on should have advanced past today, got %', next1;
  end if;

  select count(*) into expense_count from expenses where description = 'Streaming';
  if expense_count <> 1 then raise exception 'FAIL: expected one posted expense row, got %', expense_count; end if;

  select sum(owed_cents) into split_sum from expense_splits s
    join expenses e on e.id = s.expense_id where e.description = 'Streaming';
  if split_sum <> 1000 then
    raise exception 'FAIL: posted splits should sum to the recurring amount, got %', split_sum;
  end if;

  -- Calling it again the same day must be a no-op (idempotent across the
  -- twice-daily cron) — next_run_on already moved past today.
  perform post_due_recurring_expenses();
  select next_run_on into next2 from recurring_expenses where id = weekly_id;
  if next1 is distinct from next2 then
    raise exception 'FAIL: calling post_due_recurring_expenses twice moved next_run_on again';
  end if;

  select count(*) into expense_count from expenses where description = 'Streaming';
  if expense_count <> 1 then
    raise exception 'FAIL: a same-day re-run duplicated the posted expense, count=%', expense_count;
  end if;
end $$;
\echo '  ok  a due recurring expense posts exactly once, splits included, and the cron is idempotent'

-- --------------------------------------------------------------- pause

do $$
declare rent_id uuid;
begin
  perform set_config('request.user_id', 'deaaaaaa-0000-0000-0000-000000000001', false);
  select id into rent_id from recurring_expenses where description = 'Rent';

  perform set_recurring_expense_active(rent_id, false);
  update recurring_expenses set next_run_on = current_date - 1 where id = rent_id;

  if (select count(*) from post_due_recurring_expenses()) <> 0 then
    raise exception 'FAIL: a paused recurring expense still posted';
  end if;

  perform set_recurring_expense_active(rent_id, true);
  if (select count(*) from post_due_recurring_expenses()) = 0 then
    raise exception 'FAIL: reactivating a due recurring expense did not post it';
  end if;

  perform set_config('request.user_id', 'deaaaaaa-0000-0000-0000-000000000002', false);
  begin
    perform set_recurring_expense_active(rent_id, false);
    raise exception 'FAIL: a non-admin paused a recurring expense';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  pausing a recurring expense stops it from posting; only an admin can pause'
