-- The Home Assistant bridge had the same single-household assumption the kiosk
-- did: one shared token in an env var, resolved against "whichever household
-- exists". Both are really the same thing — a non-human device bound to one
-- house — so they share one registry and one token mechanism.

alter table kiosk_devices
  add column if not exists kind text not null default 'kiosk';

do $$
begin
  alter table kiosk_devices
    add constraint kiosk_devices_kind_check
    check (kind in ('kiosk', 'home_assistant'));
exception when duplicate_object then null;
end $$;

create or replace function create_device(p_name text, p_kind text default 'kiosk')
returns text
language plpgsql
security definer
set search_path = public
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
set search_path = public
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

-- Kept as thin wrappers so existing callers keep working.
create or replace function create_kiosk_device(p_name text)
returns text
language sql
security definer
set search_path = public
as $$ select create_device(p_name, 'kiosk'); $$;

create or replace function resolve_kiosk_token(p_token text)
returns uuid
language sql
security definer
set search_path = public
as $$ select resolve_device_token(p_token, 'kiosk'); $$;
