-- Run this on a database that already has 0001 and 0002.
--
-- Two changes:
--   1. Re-state security_invoker on the views in the exact form Supabase's
--      linter recognizes. `= on` and `= true` behave identically in Postgres,
--      but reloptions stores the literal token and the linter matches on
--      'true', so `on` gets reported as SECURITY DEFINER.
--   2. Decouple "who belongs to this household" from *how* they sign in, so
--      Google, magic link, or anything else all land in the right place.

alter view v_balances    set (security_invoker = true);
alter view v_chore_stats set (security_invoker = true);

-- ----------------------------------------------------------------- invites

-- The roster, keyed by email. Whoever first signs in with an invited address
-- gets that identity — name, initials, color, household — regardless of which
-- provider they used. Without this, a Google sign-in creates a profile with no
-- household and the app can only show "you're not in a household yet".
create table if not exists household_invites (
  email         text primary key,
  household_id  uuid not null references households(id) on delete cascade,
  full_name     text not null,
  initials      text not null,
  color         text not null default '#64748b',
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists household_invites_household_idx
  on household_invites (household_id);

alter table household_invites enable row level security;

drop policy if exists inv_read on household_invites;
create policy inv_read on household_invites for select
  using (is_household_member(household_id));

-- ------------------------------------------------------------ new user hook

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  inv       household_invites%rowtype;
  meta      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  resolved  text;
begin
  -- Emails are case-insensitive in practice; invites should be too.
  select * into inv
  from household_invites
  where lower(household_invites.email) = lower(new.email);

  -- Google sends 'full_name' and/or 'name'; magic-link users have whatever the
  -- seed script set; fall back to the local part of the address.
  resolved := coalesce(
    inv.full_name,
    nullif(meta ->> 'full_name', ''),
    nullif(meta ->> 'name', ''),
    split_part(new.email, '@', 1)
  );

  insert into profiles (
    id, email, full_name, initials, household_id, color, avatar_url, is_admin
  )
  values (
    new.id,
    new.email,
    resolved,
    coalesce(inv.initials, nullif(meta ->> 'initials', ''), upper(left(resolved, 2))),
    coalesce(inv.household_id, (nullif(meta ->> 'household_id', ''))::uuid),
    coalesce(inv.color, '#64748b'),
    coalesce(nullif(meta ->> 'avatar_url', ''), nullif(meta ->> 'picture', '')),
    coalesce(inv.is_admin, false)
  )
  on conflict (id) do update set
    email      = excluded.email,
    -- Never clobber an established profile: a second identity linking to the
    -- same user (magic link, then Google) must not reset their household.
    full_name  = coalesce(profiles.full_name, excluded.full_name),
    avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url),
    household_id = coalesce(profiles.household_id, excluded.household_id);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill invites for anyone already seeded, so the roster is complete even
-- if the household was set up before this migration existed.
insert into household_invites (email, household_id, full_name, initials, color, is_admin)
select p.email, p.household_id, p.full_name, p.initials, p.color, p.is_admin
from profiles p
where p.email is not null and p.household_id is not null
on conflict (email) do nothing;
