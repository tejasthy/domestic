\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data)
values ('deffffff-0000-0000-0000-000000000001','admin@updatetest.com','{"name":"Uma Admin"}');

do $$
begin
  perform set_config('request.user_id', 'deffffff-0000-0000-0000-000000000001', false);
  perform create_household('Update Test House', null, 'America/Detroit', 'Uma Admin', 'UA');
end $$;

insert into auth.users (id, email, raw_user_meta_data)
values ('deffffff-0000-0000-0000-000000000002','member@updatetest.com','{"name":"Wes Member"}');

do $$
declare c text;
begin
  perform set_config('request.user_id', 'deffffff-0000-0000-0000-000000000001', false);
  select code into c from (select (create_invite()).code) x;

  perform set_config('request.user_id', 'deffffff-0000-0000-0000-000000000002', false);
  perform redeem_invite(c, 'Wes Member', 'WM');
end $$;

-- ------------------------------------------------------------- plain -> plain

do $$
declare
  hh uuid;
  eid uuid;
  updated expenses;
  wes_owed bigint;
begin
  perform set_config('request.user_id', 'deffffff-0000-0000-0000-000000000001', false);
  select household_id into hh from profiles where id = 'deffffff-0000-0000-0000-000000000001';

  -- Mirrors what addExpense's plain path writes directly (no RPC on create).
  insert into expenses (household_id, description, amount_cents, category, paid_by, spent_on, split_kind, created_by)
  values (hh, 'Kroger run', 1000, 'groceries', 'deffffff-0000-0000-0000-000000000001', current_date, 'equal', 'deffffff-0000-0000-0000-000000000001')
  returning id into eid;
  insert into expense_splits (expense_id, profile_id, owed_cents)
  values
    (eid, 'deffffff-0000-0000-0000-000000000001', 500),
    (eid, 'deffffff-0000-0000-0000-000000000002', 500);

  updated := update_expense(
    eid, 'Kroger run (corrected)', 'deffffff-0000-0000-0000-000000000001', current_date,
    'groceries', null, null, null, 'exact',
    jsonb_build_array(
      jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000001','owed_cents',300,'weight',null),
      jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000002','owed_cents',900,'weight',null)
    )
  );

  if updated.description <> 'Kroger run (corrected)' then raise exception 'FAIL: description was not updated'; end if;
  if updated.amount_cents <> 1200 then raise exception 'FAIL: amount_cents should be the new splits'' sum, got %', updated.amount_cents; end if;
  if updated.split_kind <> 'exact'::split_kind then raise exception 'FAIL: split_kind should be exact, got %', updated.split_kind; end if;
  if (select count(*) from expense_splits where expense_id = eid) <> 2 then
    raise exception 'FAIL: expected exactly 2 splits after edit, old ones should be replaced not appended';
  end if;
  select owed_cents into wes_owed from expense_splits where expense_id = eid and profile_id = 'deffffff-0000-0000-0000-000000000002';
  if wes_owed <> 900 then raise exception 'FAIL: Wes should owe 900 after the edit, got %', wes_owed; end if;
end $$;
\echo '  ok  update_expense replaces a plain expense''s splits instead of appending to them'

-- ---------------------------------------------------------- plain -> itemized

do $$
declare
  hh uuid;
  eid uuid;
  updated expenses;
  item_count int;
  split_sum bigint;
begin
  select household_id into hh from profiles where id = 'deffffff-0000-0000-0000-000000000001';

  insert into expenses (household_id, description, amount_cents, category, paid_by, spent_on, split_kind, created_by)
  values (hh, 'Target run', 2000, 'household', 'deffffff-0000-0000-0000-000000000001', current_date, 'equal', 'deffffff-0000-0000-0000-000000000001')
  returning id into eid;
  insert into expense_splits (expense_id, profile_id, owed_cents)
  values
    (eid, 'deffffff-0000-0000-0000-000000000001', 1000),
    (eid, 'deffffff-0000-0000-0000-000000000002', 1000);

  updated := update_expense(
    eid, 'Target run', 'deffffff-0000-0000-0000-000000000001', current_date,
    'household', null, null,
    jsonb_build_array(
      jsonb_build_object(
        'name', 'Paper towels', 'amount_cents', 600, 'kind', 'item', 'split_kind', 'equal',
        'splits', jsonb_build_array(
          jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000001','owed_cents',300,'weight',null),
          jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000002','owed_cents',300,'weight',null)
        )
      ),
      jsonb_build_object(
        'name', 'Tax', 'amount_cents', 40, 'kind', 'tax', 'split_kind', 'equal',
        'splits', jsonb_build_array(
          jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000001','owed_cents',40,'weight',null)
        )
      )
    )
  );

  if updated.split_kind <> 'itemized'::split_kind then raise exception 'FAIL: split_kind should be itemized after switching to items, got %', updated.split_kind; end if;
  if updated.amount_cents <> 640 then raise exception 'FAIL: amount_cents should be the sum of items, got %', updated.amount_cents; end if;

  select count(*) into item_count from expense_items where expense_id = eid;
  if item_count <> 2 then raise exception 'FAIL: expected 2 expense_items rows, got %', item_count; end if;

  select sum(owed_cents) into split_sum from expense_splits where expense_id = eid;
  if split_sum <> 640 then raise exception 'FAIL: aggregated expense_splits should sum to 640, got %', split_sum; end if;

  -- Now switch back to a plain split — the items must be cleaned up, not left dangling.
  perform update_expense(
    eid, 'Target run', 'deffffff-0000-0000-0000-000000000001', current_date,
    'household', null, null, null, 'equal',
    jsonb_build_array(
      jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000001','owed_cents',500,'weight',null),
      jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000002','owed_cents',500,'weight',null)
    )
  );
  if (select split_kind from expenses where id = eid) <> 'equal'::split_kind then
    raise exception 'FAIL: split_kind should be equal after switching back off items';
  end if;
  if (select count(*) from expense_items where expense_id = eid) <> 0 then
    raise exception 'FAIL: expense_items should be gone after switching back to a plain split';
  end if;
  if (select count(*) from expense_item_splits eis join expense_items ei on ei.id = eis.expense_item_id where ei.expense_id = eid) <> 0 then
    raise exception 'FAIL: expense_item_splits should be gone after switching back to a plain split';
  end if;
end $$;
\echo '  ok  update_expense can switch an expense between plain and itemized and cleans up the side it left'

-- --------------------------------------------------------------- rejections

do $$
declare
  hh uuid;
  eid uuid;
  before_desc text;
  before_split_count int;
begin
  select household_id into hh from profiles where id = 'deffffff-0000-0000-0000-000000000001';

  insert into expenses (household_id, description, amount_cents, category, paid_by, spent_on, split_kind, created_by)
  values (hh, 'Stable expense', 1000, 'general', 'deffffff-0000-0000-0000-000000000001', current_date, 'equal', 'deffffff-0000-0000-0000-000000000001')
  returning id into eid;
  insert into expense_splits (expense_id, profile_id, owed_cents)
  values
    (eid, 'deffffff-0000-0000-0000-000000000001', 500),
    (eid, 'deffffff-0000-0000-0000-000000000002', 500);

  select description into before_desc from expenses where id = eid;
  select count(*) into before_split_count from expense_splits where expense_id = eid;

  -- An item whose splits don't sum to its amount must be rejected, and must
  -- not leave the expense half-edited.
  begin
    perform update_expense(
      eid, 'Bad edit', 'deffffff-0000-0000-0000-000000000001', current_date,
      'general', null, null,
      jsonb_build_array(jsonb_build_object(
        'name', 'Oops', 'amount_cents', 500, 'kind', 'item', 'split_kind', 'exact',
        'splits', jsonb_build_array(jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000001','owed_cents',100,'weight',null))
      ))
    );
    raise exception 'FAIL: update_expense accepted an item whose splits do not sum to its amount';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  if (select description from expenses where id = eid) <> before_desc then
    raise exception 'FAIL: a rejected item edit changed the expense description';
  end if;
  if (select count(*) from expense_splits where expense_id = eid) <> before_split_count then
    raise exception 'FAIL: a rejected item edit left the original splits gone';
  end if;

  -- Someone outside the household can't be assigned in a plain edit either.
  begin
    perform update_expense(
      eid, 'Sneaky edit', 'deffffff-0000-0000-0000-000000000001', current_date,
      'general', null, null, null, 'equal',
      jsonb_build_array(jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000099','owed_cents',1000,'weight',null))
    );
    raise exception 'FAIL: update_expense accepted an assignee outside the household';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- Editing a deleted expense must fail rather than resurrect it.
  update expenses set deleted_at = now() where id = eid;
  begin
    perform update_expense(
      eid, 'Zombie edit', 'deffffff-0000-0000-0000-000000000001', current_date,
      'general', null, null, null, 'equal',
      jsonb_build_array(jsonb_build_object('profile_id','deffffff-0000-0000-0000-000000000001','owed_cents',1000,'weight',null))
    );
    raise exception 'FAIL: update_expense edited a soft-deleted expense';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  update_expense rejects bad item splits, outside assignees, and edits to a deleted expense without corrupting state'
