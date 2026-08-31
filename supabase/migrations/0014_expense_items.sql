-- Line-item breakdown for a scanned (or manually itemized) receipt: each
-- item/tax/tip/discount row on the receipt gets its own assignees and its
-- own split method, instead of one split_kind for the whole expense.
--
-- expenses.split_kind = 'itemized' means "read expense_splits as an
-- aggregate of expense_item_splits, not as a directly-entered split" — the
-- expense_splits row shape and its consumers (v_balances, settlements,
-- the ledger UI) are untouched, so nothing downstream needs to know
-- itemization exists.
create table if not exists expense_items (
  id            uuid primary key default gen_random_uuid(),
  expense_id    uuid not null references expenses(id) on delete cascade,
  name          text not null,
  amount_cents  bigint not null,  -- negative allowed: a discount/fee row nets against the total
  kind          text not null default 'item'
                  check (kind in ('item', 'tax', 'tip', 'discount', 'fee')),
  split_kind    split_kind not null default 'equal',  -- never 'itemized' — see create_itemized_expense
  position      smallint not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists expense_items_expense_id_position_idx on expense_items (expense_id, position);

-- Mirrors expense_splits, but no owed_cents >= 0 check: a discount item's
-- amount_cents is negative, and so are the shares of it each assignee gets.
-- What must never go negative is a person's *aggregate* across all items —
-- enforced in create_itemized_expense when it rolls these up into
-- expense_splits, which keeps its owed_cents >= 0 check.
create table if not exists expense_item_splits (
  expense_item_id  uuid   not null references expense_items(id) on delete cascade,
  profile_id       uuid   not null references profiles(id) on delete cascade,
  owed_cents       bigint not null,
  weight           numeric(10,4),
  primary key (expense_item_id, profile_id)
);

create index if not exists expense_item_splits_profile_id_idx on expense_item_splits (profile_id);

-- RLS: same shape as expenses/expense_splits (0002_logic.sql) — read/write
-- gated by household membership via the parent expense, checked through a
-- join since these tables carry no household_id column of their own.
alter table expense_items enable row level security;
alter table expense_item_splits enable row level security;

drop policy if exists items_all on expense_items;
create policy items_all on expense_items
  using (exists (
    select 1 from expenses e
    where e.id = expense_items.expense_id and is_household_member(e.household_id)
  ))
  with check (exists (
    select 1 from expenses e
    where e.id = expense_items.expense_id and is_household_member(e.household_id)
  ));

drop policy if exists item_splits_all on expense_item_splits;
create policy item_splits_all on expense_item_splits
  using (exists (
    select 1 from expense_items i
    join expenses e on e.id = i.expense_id
    where i.id = expense_item_splits.expense_item_id and is_household_member(e.household_id)
  ))
  with check (exists (
    select 1 from expense_items i
    join expenses e on e.id = i.expense_id
    where i.id = expense_item_splits.expense_item_id and is_household_member(e.household_id)
  ));

/* --------------------------------------------------------------- creation */

-- Atomic: an expense, its line items, each item's per-person splits, and the
-- resulting expense_splits aggregate all land together or not at all — a
-- receipt with items assigned to no one, or a half-written aggregate, would
-- silently skew v_balances the same way a bad addExpense() insert would.
--
-- p_items shape:
--   [{ "name": "...", "amount_cents": bigint, "kind": "item"|"tax"|"tip"|"discount"|"fee",
--      "split_kind": split_kind (not 'itemized'),
--      "splits": [{ "profile_id": uuid, "owed_cents": bigint, "weight": numeric|null }, ...] }, ...]
create or replace function create_itemized_expense(
  p_description  text,
  p_paid_by      uuid,
  p_spent_on     date,
  p_items        jsonb,
  p_category     text default 'general',
  p_receipt_url  text default null,
  p_note         text default null
)
returns expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  hh        uuid;
  row_out   expenses%rowtype;
  item      jsonb;
  item_id   uuid;
  item_total bigint;
  splits_total bigint;
  total     bigint;
  neg_person uuid;
begin
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  if not exists (select 1 from profiles where id = p_paid_by and household_id = hh) then
    raise exception 'the payer must be in your household';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a receipt needs at least one item';
  end if;
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

  insert into expenses (
    household_id, description, amount_cents, category, paid_by, spent_on,
    split_kind, receipt_url, note, created_by
  )
  values (
    hh, trim(p_description), total, coalesce(p_category, 'general'), p_paid_by, p_spent_on,
    'itemized', p_receipt_url, p_note, auth.uid()
  )
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
      row_out.id, item ->> 'name', item_total,
      coalesce(item ->> 'kind', 'item'),
      coalesce((item ->> 'split_kind')::split_kind, 'equal'),
      coalesce((item ->> 'position')::smallint, 0)
    )
    returning id into item_id;

    insert into expense_item_splits (expense_item_id, profile_id, owed_cents, weight)
    select item_id, (s ->> 'profile_id')::uuid, (s ->> 'owed_cents')::bigint, (s ->> 'weight')::numeric
    from jsonb_array_elements(item -> 'splits') as s;
  end loop;

  -- Check before inserting: expense_splits.owed_cents has its own
  -- `>= 0` check constraint, which would otherwise fire first with a raw
  -- Postgres error instead of this friendlier one.
  select agg.profile_id into neg_person
  from (
    select profile_id, sum(owed_cents) as total
    from expense_item_splits
    where expense_item_id in (select id from expense_items where expense_id = row_out.id)
    group by profile_id
  ) agg
  where agg.total < 0
  limit 1;
  if neg_person is not null then
    raise exception 'no one can end up owing a negative share — assign the discount alongside a purchased item';
  end if;

  insert into expense_splits (expense_id, profile_id, owed_cents)
  select row_out.id, profile_id, sum(owed_cents)
  from expense_item_splits
  where expense_item_id in (select id from expense_items where expense_id = row_out.id)
  group by profile_id;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (
    hh, auth.uid(), 'added_expense',
    row_out.description || ' — $' || to_char(total / 100.0, 'FM999999990.00'),
    jsonb_build_object('expense_id', row_out.id, 'amount_cents', total)
  );

  return row_out;
end;
$$;
