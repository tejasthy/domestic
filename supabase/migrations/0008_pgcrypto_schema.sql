-- pgcrypto does not live in `public` on Supabase.
--
-- Supabase pre-installs pgcrypto into the `extensions` schema, so 0001's
-- `create extension if not exists "pgcrypto"` is a no-op there and never moves
-- it into `public`. Stock Postgres has no such schema, so the same statement
-- installs it into `public` — which is why the device functions worked in the
-- test container and in local dev, and failed in production with
-- `function gen_random_bytes(integer) does not exist`.
--
-- Both device functions are `security definer` with `set search_path = public`,
-- which is what pins them to a schema that may not hold pgcrypto. Adding
-- `extensions` covers both layouts: Postgres silently ignores a schema in
-- search_path that does not exist, so this stays correct on stock Postgres.
--
-- Keep `extensions` on the search_path of any future security-definer function
-- that calls digest(), gen_random_bytes(), crypt(), or hmac().

-- Guarantee pgcrypto exists somewhere first. If it is already installed this
-- leaves it exactly where it is (in `public` on stock Postgres, `extensions` on
-- Supabase); if it is not installed at all, put it in `extensions`. Together
-- with the search_path below, all three layouts resolve.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    create schema if not exists extensions;
    create extension pgcrypto with schema extensions;
  end if;
end $$;

create or replace function create_device(p_name text, p_kind text default 'kiosk')
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  hh   uuid;
  code text;
begin
  if not is_household_admin() then raise exception 'only an admin can add a device'; end if;
  if p_kind not in ('kiosk', 'home_assistant') then
    raise exception 'unknown device kind %', p_kind;
  end if;

  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  -- 24 bytes of CSPRNG, url-safe. Returned once; only the hash is kept.
  code := replace(replace(replace(encode(gen_random_bytes(24), 'base64'), '+', '-'), '/', '_'), '=', '');

  insert into kiosk_devices (household_id, name, kind, token_hash, created_by)
  values (hh, coalesce(nullif(trim(p_name), ''), 'Device'), p_kind,
          encode(digest(code, 'sha256'), 'hex'), auth.uid());

  return code;
end;
$$;

create or replace function resolve_device_token(p_token text, p_kind text default null)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare hh uuid;
begin
  update kiosk_devices
     set last_seen_at = now()
   where token_hash = encode(digest(p_token, 'sha256'), 'hex')
     and (p_kind is null or kind = p_kind)
  returning household_id into hh;

  return hh;
end;
$$;
