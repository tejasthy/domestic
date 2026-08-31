-- Receipt scanning was wired to a single global ANTHROPIC_API_KEY env var,
-- picked up implicitly by `new Anthropic()`. That does not fit "any household
-- can deploy and run themselves" — each deployed house should be able to pick
-- its own provider (Anthropic or Gemini) and supply its own key.
--
-- An API key is a bearer credential, not a UI preference, so it does not live
-- in household_modules.settings — that column is readable by any member via
-- the existing mod_read policy. household_ai_config instead carries RLS with
-- *zero* policies: RLS enabled and no policy of any kind denies every row to
-- every client role, including this household's own admin browsing the app —
-- only a SECURITY DEFINER function (or the service role, which bypasses RLS
-- entirely) can read or write it. The key is additionally encrypted with
-- pgcrypto, already installed for this project (0008) — RLS stops the app's
-- normal query paths, encryption is the second layer that protects a Postgres
-- dump, backup, or read replica from leaking a raw vendor API key.
--
-- The encryption secret is passed as an argument on every call, not stored as
-- a Postgres GUC, so it stays inside this app's existing "secrets live in
-- .env" convention rather than adding a second secret-management surface.

create table if not exists household_ai_config (
  household_id  uuid primary key references households(id) on delete cascade,
  provider      text not null check (provider in ('anthropic', 'gemini')),
  api_key_enc   bytea not null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references profiles(id) on delete set null
);

alter table household_ai_config enable row level security;
-- Deliberately no policy at all — see comment above.

create or replace function set_ai_config(p_provider text, p_api_key text, p_secret text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare hh uuid;
begin
  if not is_household_admin() then raise exception 'only an admin can change this'; end if;
  if p_provider not in ('anthropic', 'gemini') then raise exception 'unknown provider %', p_provider; end if;
  if coalesce(trim(p_api_key), '') = '' then raise exception 'enter an API key'; end if;

  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  insert into household_ai_config (household_id, provider, api_key_enc, updated_by)
  values (hh, p_provider, pgp_sym_encrypt(p_api_key, p_secret), auth.uid())
  on conflict (household_id) do update
    set provider    = excluded.provider,
        api_key_enc = excluded.api_key_enc,
        updated_at  = now(),
        updated_by  = auth.uid();
end;
$$;

create or replace function clear_ai_config()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare hh uuid;
begin
  if not is_household_admin() then raise exception 'only an admin can change this'; end if;
  select household_id into hh from profiles where id = auth.uid();
  delete from household_ai_config where household_id = hh;
end;
$$;

-- Enough for the admin settings screen to render "Anthropic — configured";
-- never returns the key, so this is safe to call from anywhere a signed-in
-- member can reach, not just admins.
create or replace function get_ai_config_summary()
returns table(provider text, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.provider, c.updated_at
  from household_ai_config c
  join profiles p on p.household_id = c.household_id
  where p.id = auth.uid();
$$;

-- Used only from server-side code (the receipt route), never a client
-- component — the decrypted key must never appear in a response body.
create or replace function get_ai_credentials(p_secret text)
returns table(provider text, api_key text)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare hh uuid;
begin
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then return; end if;
  return query
    select c.provider, pgp_sym_decrypt(c.api_key_enc, p_secret)
    from household_ai_config c
    where c.household_id = hh;
end;
$$;
