\set ON_ERROR_STOP on

insert into auth.users (id, email, raw_user_meta_data)
values ('debbbbbb-0000-0000-0000-000000000001','admin@itemtest.com','{"name":"Ivy Admin"}');

do $$
begin
  perform set_config('request.user_id', 'debbbbbb-0000-0000-0000-000000000001', false);
  perform create_household('Item Test House', null, 'America/Detroit', 'Ivy Admin', 'IA');
end $$;

insert into auth.users (id, email, raw_user_meta_data)
values ('debbbbbb-0000-0000-0000-000000000002','member@itemtest.com','{"name":"Milo Member"}');

do $$
declare c text;
begin
  perform set_config('request.user_id', 'debbbbbb-0000-0000-0000-000000000001', false);
  select code into c from (select (create_invite()).code) x;

  perform set_config('request.user_id', 'debbbbbb-0000-0000-0000-000000000002', false);
  perform redeem_invite(c, 'Milo Member', 'MM');
end $$;

-- ------------------------------------------------------------------ create

do $$
declare
  hh uuid;
  new_id uuid;
  split_sum bigint;
  ivy_owed bigint;
  milo_owed bigint;
begin
  perform set_config('request.user_id', 'debbbbbb-0000-0000-0000-000000000001', false);
  select household_id into hh from profiles where id = 'debbbbbb-0000-0000-0000-000000000001';

  -- One item split 60/40 by percent between the two of them, one tax row
  -- assigned only to Ivy.
  select (create_itemized_expense(
    'Kroger run', 'debbbbbb-0000-0000-0000-000000000001', current_date,
    jsonb_build_array(
      jsonb_build_object(
        'name', 'Groceries', 'amount_cents', 1000, 'kind', 'item', 'split_kind', 'percent',
        'splits', jsonb_build_array(
          jsonb_build_object('profile_id','debbbbbb-0000-0000-0000-000000000001','owed_cents',600,'weight',60),
          jsonb_build_object('profile_id','debbbbbb-0000-0000-0000-000000000002','owed_cents',400,'weight',40)
        )
      ),
      jsonb_build_object(
        'name', 'Tax', 'amount_cents', 80, 'kind', 'tax', 'split_kind', 'equal',
        'splits', jsonb_build_array(
          jsonb_build_object('profile_id','debbbbbb-0000-0000-0000-000000000001','owed_cents',80,'weight',null)
        )
      )
    ),
    'groceries'
  )).id into new_id;

  if new_id is null then raise exception 'FAIL: create_itemized_expense did not return a row'; end if;
  if (select household_id from expenses where id = new_id) is distinct from hh then
    raise exception 'FAIL: itemized expense was not attached to the caller''s household';
  end if;
  if (select split_kind from expenses where id = new_id) is distinct from 'itemized'::split_kind then
    raise exception 'FAIL: expense.split_kind should be itemized';
  end if;
  if (select amount_cents from expenses where id = new_id) <> 1080 then
    raise exception 'FAIL: amount_cents should be the sum of item amounts, got %', (select amount_cents from expenses where id = new_id);
  end if;
  if (select count(*) from expense_items where expense_id = new_id) <> 2 then
    raise exception 'FAIL: expected 2 expense_items rows';
  end if;

  select sum(owed_cents) into split_sum from expense_splits where expense_id = new_id;
  if split_sum <> 1080 then raise exception 'FAIL: expense_splits should sum to the total, got %', split_sum; end if;

  select owed_cents into ivy_owed from expense_splits where expense_id = new_id and profile_id = 'debbbbbb-0000-0000-0000-000000000001';
  select owed_cents into milo_owed from expense_splits where expense_id = new_id and profile_id = 'debbbbbb-0000-0000-0000-000000000002';
  if ivy_owed <> 680 then raise exception 'FAIL: Ivy should owe 600 (item) + 80 (tax) = 680, got %', ivy_owed; end if;
  if milo_owed <> 400 then raise exception 'FAIL: Milo should owe 400, got %', milo_owed; end if;

  -- An item whose splits don't sum to its amount must be rejected, and must
  -- not leave a half-written expense behind.
  begin
    perform create_itemized_expense(
      'Bad item', 'debbbbbb-0000-0000-0000-000000000001', current_date,
      jsonb_build_array(jsonb_build_object(
        'name', 'Oops', 'amount_cents', 500, 'kind', 'item', 'split_kind', 'exact',
        'splits', jsonb_build_array(jsonb_build_object('profile_id','debbbbbb-0000-0000-0000-000000000001','owed_cents',100,'weight',null))
      ))
    );
    raise exception 'FAIL: create_itemized_expense accepted an item whose splits do not sum to its amount';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
  if exists (select 1 from expenses where description = 'Bad item') then
    raise exception 'FAIL: a rejected itemized expense left a row behind';
  end if;

  -- Someone outside the household can't be assigned an item.
  begin
    perform create_itemized_expense(
      'Sneaky assignee', 'debbbbbb-0000-0000-0000-000000000001', current_date,
      jsonb_build_array(jsonb_build_object(
        'name', 'Thing', 'amount_cents', 100, 'kind', 'item', 'split_kind', 'equal',
        'splits', jsonb_build_array(jsonb_build_object('profile_id','debbbbbb-0000-0000-0000-000000000099','owed_cents',100,'weight',null))
      ))
    );
    raise exception 'FAIL: create_itemized_expense accepted an assignee outside the household';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- A discount assigned only to one person, larger than everything else they
  -- bought, must not leave them with a negative aggregate share.
  begin
    perform create_itemized_expense(
      'Over-discounted', 'debbbbbb-0000-0000-0000-000000000001', current_date,
      jsonb_build_array(
        jsonb_build_object(
          'name', 'Snack', 'amount_cents', 200, 'kind', 'item', 'split_kind', 'equal',
          'splits', jsonb_build_array(jsonb_build_object('profile_id','debbbbbb-0000-0000-0000-000000000001','owed_cents',200,'weight',null))
        ),
        jsonb_build_object(
          'name', 'Coupon', 'amount_cents', -500, 'kind', 'discount', 'split_kind', 'equal',
          'splits', jsonb_build_array(jsonb_build_object('profile_id','debbbbbb-0000-0000-0000-000000000001','owed_cents',-500,'weight',null))
        )
      )
    );
    raise exception 'FAIL: create_itemized_expense allowed a negative aggregate share';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  itemized expenses aggregate per-item splits into expense_splits; bad splits, outside assignees, and negative aggregates are all rejected'
