-- Fourth course-correction: 0025's is_platform_admin() relied on a Postgres
-- GUC set via `alter database ... set app.platform_admin_emails = '...'`.
-- Confirmed against the real project: Supabase's managed Postgres refuses
-- that statement outright ("permission denied to set parameter") for every
-- role available to a project owner, including the SQL Editor's — not a
-- permissions oversight on our end, a platform-wide restriction. The GUC
-- design cannot work here at all, on this project or anyone else's.
--
-- Replacement: a one-row, zero-RLS-policy table (same locked-down pattern as
-- household_ai_config/feedback_submissions), writable only by a
-- service-role-only RPC — bootstrapped by running a small local script with
-- the service role key every deployment already has
-- (scripts/set-platform-admin.mjs), the same way this repo already asks you
-- to run `npm run gen:secrets`/`npm run gen:vapid` once per deployment.

create table if not exists platform_config (
  id           boolean primary key default true check (id),
  admin_emails text[]  not null default '{}'
);

insert into platform_config (id) values (true) on conflict do nothing;

alter table platform_config enable row level security;
-- No policies at all — every read goes through is_platform_admin() below,
-- every write through set_platform_admin_emails(), never a direct query.

create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select lower(email) from profiles where id = auth.uid())
      = any (select lower(e) from platform_config, unnest(admin_emails) as e where id = true),
    false
  );
$$;

-- service_role only — the same lockdown shape 0015 uses for the kiosk RPCs.
-- Never callable by a signed-in member: this is exactly the allowlist that
-- decides who can act as a platform operator, so it must not be settable by
-- anyone the RPC itself would call a platform admin.
create or replace function set_platform_admin_emails(p_emails text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update platform_config
     set admin_emails = (select coalesce(array_agg(lower(trim(e))), '{}') from unnest(p_emails) e where trim(e) <> '')
   where id = true;
end;
$$;

do $$
declare r text;
begin
  foreach r in array array['authenticated', 'anon', 'domestic_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function set_platform_admin_emails(text[]) from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function set_platform_admin_emails(text[]) to service_role;
  end if;
end $$;

revoke execute on function set_platform_admin_emails(text[]) from public;
