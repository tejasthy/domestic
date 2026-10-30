-- An atomic home for the plain (non-itemized) expense, the way
-- create_itemized_expense (0014) is for receipts.
--
-- The app's addExpense() inserts the expense, then its splits, and deletes the
-- expense again if the splits fail. That is fine for one client, but a second
-- caller — the MCP endpoint — should not have to re-implement the rollback, and
-- a crash between the two inserts would leave an expense with no splits, which
-- silently skews every balance in the house. Here it is one transaction.
--
-- The caller works out the shares (money.ts keeps them remainder-safe); this
-- only checks them and writes.
--
--   p_shares: [{ "profile_id": uuid, "owed_cents": bigint, "weight": numeric|null }, ...]

create or replace function create_expense(
  p_description   text,
  p_amount_cents  bigint,
  p_paid_by       uuid,
  p_spent_on      date,
  p_split_kind    text,
  p_shares        jsonb,
  p_category      text default 'general',
  p_note          text default null
)
returns expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  hh            uuid;
  row_out       expenses%rowtype;
  shares_total  bigint;
begin
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  if length(trim(coalesce(p_description, ''))) = 0 then raise exception 'give it a name'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'the amount must be greater than zero';
  end if;
  if p_split_kind not in ('equal', 'exact', 'shares', 'percent', 'adjustment') then
    raise exception 'unknown split kind %', p_split_kind;
  end if;
  if not exists (select 1 from profiles where id = p_paid_by and household_id = hh) then
    raise exception 'the payer must be in your household';
  end if;

  if jsonb_typeof(p_shares) is distinct from 'array' or jsonb_array_length(p_shares) = 0 then
    raise exception 'split it with someone';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_shares) as s(profile_id uuid, owed_cents bigint, weight numeric)
    where not exists (select 1 from profiles where id = s.profile_id and household_id = hh)
  ) then
    raise exception 'everyone in the split must be in your household';
  end if;
  if (
    select count(*) <> count(distinct s.profile_id)
    from jsonb_to_recordset(p_shares) as s(profile_id uuid)
  ) then
    raise exception 'each person can only appear once in the split';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_shares) as s(owed_cents bigint) where s.owed_cents < 0
  ) then
    raise exception 'no one can owe a negative share';
  end if;

  select sum(s.owed_cents) into shares_total
  from jsonb_to_recordset(p_shares) as s(owed_cents bigint);
  if shares_total is distinct from p_amount_cents then
    raise exception 'the shares must add up to the total';
  end if;

  insert into expenses (
    household_id, description, amount_cents, category, paid_by, spent_on,
    split_kind, note, created_by
  )
  values (
    hh, trim(p_description), p_amount_cents,
    coalesce(nullif(trim(p_category), ''), 'general'),
    p_paid_by, p_spent_on, p_split_kind::split_kind, p_note, auth.uid()
  )
  returning * into row_out;

  insert into expense_splits (expense_id, profile_id, owed_cents, weight)
  select row_out.id, s.profile_id, s.owed_cents, s.weight
  from jsonb_to_recordset(p_shares) as s(profile_id uuid, owed_cents bigint, weight numeric);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select hh, auth.uid(), 'added_expense',
         p.full_name || ' added ' || row_out.description
           || ' — $' || to_char(p_amount_cents / 100.0, 'FM999999990.00'),
         jsonb_build_object('expense_id', row_out.id, 'amount_cents', p_amount_cents)
  from profiles p where p.id = auth.uid();

  return row_out;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function create_expense(text, bigint, uuid, date, text, jsonb, text, text) from anon;
  end if;
end $$;
revoke execute on function create_expense(text, bigint, uuid, date, text, jsonb, text, text) from public;

do $$
declare r text;
begin
  foreach r in array array['authenticated', 'domestic_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format(
        'grant execute on function create_expense(text, bigint, uuid, date, text, jsonb, text, text) to %I', r);
    end if;
  end loop;
end $$;
