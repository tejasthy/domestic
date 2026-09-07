-- The "Nudge" action (requestSettleUp) only ever sent a push notification —
-- useless if the recipient doesn't have push enabled on this device, and
-- easy to miss even when they do. Give it a real in-app row, same shape as
-- chore_swaps: a pending-thing-that-needs-your-attention table the
-- recipient's own client queries directly, surfaced in "Needs an answer"
-- alongside swap requests.

create table if not exists settle_nudges (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  from_profile  uuid not null references profiles(id) on delete cascade, -- who owes (the recipient)
  to_profile    uuid not null references profiles(id) on delete cascade, -- who is owed (sent it)
  amount_cents  bigint not null check (amount_cents > 0),
  created_at    timestamptz not null default now(),
  dismissed_at  timestamptz,
  check (from_profile <> to_profile)
);

create index if not exists settle_nudges_from_profile_pending_idx
  on settle_nudges (from_profile) where dismissed_at is null;

alter table settle_nudges enable row level security;

-- Read: anyone in the household (matches every other household table) — the
-- app itself only ever queries a viewer's own pending nudges.
drop policy if exists settle_nudges_read on settle_nudges;
create policy settle_nudges_read on settle_nudges for select
  using (is_household_member(household_id));

-- Insert: only as the creditor, for someone in the same household — mirrors
-- requestSettleUp's own checks, enforced again here since RLS is the real
-- boundary.
drop policy if exists settle_nudges_insert on settle_nudges;
create policy settle_nudges_insert on settle_nudges for insert
  with check (
    is_household_member(household_id)
    and to_profile = auth.uid()
    and exists (select 1 from profiles p where p.id = from_profile and p.household_id = household_id)
  );

-- Dismiss: either side of the nudge — the recipient clearing "seen it,
-- dealing with it," or recordPayment auto-clearing it once the debt is
-- actually settled (which can be recorded by either party).
drop policy if exists settle_nudges_dismiss on settle_nudges;
create policy settle_nudges_dismiss on settle_nudges for update
  using (from_profile = auth.uid() or to_profile = auth.uid())
  with check (from_profile = auth.uid() or to_profile = auth.uid());
