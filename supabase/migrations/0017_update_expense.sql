-- Editing an expense in place: replaces its splits (and, for itemized
-- expenses, its items) atomically, the same way create_itemized_expense
-- writes them atomically on the way in. Mirrors that function's validation
-- so a bad edit comes back as a friendly error instead of a raw Postgres one,
-- and so a half-written split set can never desync v_balances.
--
-- p_items non-null/non-empty -> itemized edit, same shape as
-- create_itemized_expense's p_items. p_items null/empty -> plain edit,
-- p_splits carries the already-computed [{profile_id, owed_cents, weight}]
-- (split math itself stays in TypeScript/money.ts, same as addExpense).
create or replace function update_expense(
  p_expense_id   uuid,
  p_description  text,
  p_paid_by      uuid,
  p_spent_on     date,
  p_category     text default 'general',
  p_receipt_url  text default null,
  p_note         text default null,
  p_items        jsonb default null,
  p_split_kind   split_kind default 'equal',
  p_splits       jsonb default null
)
returns expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  hh           uuid;
  row_out      expenses%rowtype;
  item         jsonb;
  item_id      uuid;
  item_total   bigint;
  splits_total bigint;
  total        bigint;
  neg_person   uuid;
begin
  select household_id into hh from expenses where id = p_expense_id and deleted_at is null;
  if hh is null then raise exception 'expense not found'; end if;
  if not is_household_member(hh) then raise exception 'not your household'; end if;

  if not exists (select 1 from profiles where id = p_paid_by and household_id = hh) then
    raise exception 'the payer must be in your household';
  end if;

  if p_items is not null and jsonb_array_length(p_items) > 0 then
    if exists (
      select 1
      from jsonb_array_elements(p_items) as it,
           jsonb_to_recordset(it -> 'splits') as s(profile_id uuid, owed_cents bigint, weight numeric)
      where not exists (select 1 from profiles where id = s.profile_id and household_id = hh)
    ) then
      raise exception 'everyone assigned to an item must be in your household';
    end if;

    select sum((it ->> 'amount_cents')::bigint) into total
    from jsonb_array_elements(p_items) as it;

    -- Cascades to expense_item_splits; a no-op if the expense wasn't itemized before.
    delete from expense_items where expense_id = p_expense_id;
    delete from expense_splits where expense_id = p_expense_id;

    update expenses set
      description  = trim(p_description),
      amount_cents = total,
      category     = coalesce(p_category, 'general'),
      paid_by      = p_paid_by,
      spent_on     = p_spent_on,
      split_kind   = 'itemized',
      receipt_url  = p_receipt_url,
      note         = p_note,
      updated_at   = now()
    where id = p_expense_id
    returning * into row_out;

    for item in select * from jsonb_array_elements(p_items)
    loop
      item_total := (item ->> 'amount_cents')::bigint;

      select coalesce(sum((s ->> 'owed_cents')::bigint), 0) into splits_total
      from jsonb_array_elements(item -> 'splits') as s;
      if splits_total is distinct from item_total then
        raise exception 'splits for "%" must add up to its amount', item ->> 'name';
      end if;

      insert into expense_items (expense_id, name, amount_cents, kind, split_kind, position)
      values (
        p_expense_id, item ->> 'name', item_total,
        coalesce(item ->> 'kind', 'item'),
        coalesce((item ->> 'split_kind')::split_kind, 'equal'),
        coalesce((item ->> 'position')::smallint, 0)
      )
      returning id into item_id;

      insert into expense_item_splits (expense_item_id, profile_id, owed_cents, weight)
      select item_id, (s ->> 'profile_id')::uuid, (s ->> 'owed_cents')::bigint, (s ->> 'weight')::numeric
      from jsonb_array_elements(item -> 'splits') as s;
    end loop;

    select agg.profile_id into neg_person
    from (
      select profile_id, sum(owed_cents) as total
      from expense_item_splits
      where expense_item_id in (select id from expense_items where expense_id = p_expense_id)
      group by profile_id
    ) agg
    where agg.total < 0
    limit 1;
    if neg_person is not null then
      raise exception 'no one can end up owing a negative share — assign the discount alongside a purchased item';
    end if;

    insert into expense_splits (expense_id, profile_id, owed_cents)
    select p_expense_id, profile_id, sum(owed_cents)
    from expense_item_splits
    where expense_item_id in (select id from expense_items where expense_id = p_expense_id)
    group by profile_id;

  else
    if p_splits is null or jsonb_array_length(p_splits) = 0 then
      raise exception 'split it with someone';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(p_splits) as s(profile_id uuid, owed_cents bigint, weight numeric)
      where not exists (select 1 from profiles where id = s.profile_id and household_id = hh)
    ) then
      raise exception 'everyone in the split must be in your household';
    end if;
    if exists (
      select 1 from jsonb_to_recordset(p_splits) as s(profile_id uuid, owed_cents bigint, weight numeric)
      where s.owed_cents < 0
    ) then
      raise exception 'no one can owe a negative amount';
    end if;

    select sum((s ->> 'owed_cents')::bigint) into total
    from jsonb_array_elements(p_splits) as s;
    if total is null or total <= 0 then
      raise exception 'enter an amount greater than zero';
    end if;

    -- Cascades to expense_item_splits; a no-op if the expense wasn't itemized before.
    delete from expense_items where expense_id = p_expense_id;
    delete from expense_splits where expense_id = p_expense_id;

    update expenses set
      description  = trim(p_description),
      amount_cents = total,
      category     = coalesce(p_category, 'general'),
      paid_by      = p_paid_by,
      spent_on     = p_spent_on,
      split_kind   = p_split_kind,
      receipt_url  = p_receipt_url,
      note         = p_note,
      updated_at   = now()
    where id = p_expense_id
    returning * into row_out;

    insert into expense_splits (expense_id, profile_id, owed_cents, weight)
    select p_expense_id, (s ->> 'profile_id')::uuid, (s ->> 'owed_cents')::bigint, (s ->> 'weight')::numeric
    from jsonb_array_elements(p_splits) as s;
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (
    hh, auth.uid(), 'updated_expense',
    row_out.description || ' — $' || to_char(row_out.amount_cents / 100.0, 'FM999999990.00'),
    jsonb_build_object('expense_id', row_out.id, 'amount_cents', row_out.amount_cents)
  );

  return row_out;
end;
$$;
