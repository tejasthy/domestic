-- Per-person rate limiting for the MCP endpoint (/api/mcp).
--
-- Vercel functions share no memory, so a counter in the function process would
-- reset on every cold start and differ per instance. The count lives here
-- instead: one row per person, bucket and time window, bumped atomically with
-- a single upsert. Fixed windows are coarse but cheap, and the endpoint only
-- needs to stop a runaway assistant loop from burning the house's Vercel and
-- database budget, not to meter fairly.
--
-- Like household_ai_config this table has RLS on and *no policy*: nobody reads
-- or writes it through the API, only the SECURITY DEFINER function below does.

create table if not exists mcp_rate_limits (
  profile_id    uuid        not null references profiles(id) on delete cascade,
  bucket        text        not null,
  window_start  timestamptz not null,
  hits          integer     not null default 0,
  primary key (profile_id, bucket, window_start)
);

alter table mcp_rate_limits enable row level security;
-- Deliberately no policy.

-- Counts one call and says whether it is within the limit. The caller passes
-- the limit and window so tuning them never needs a migration; the bucket and
-- window are validated so a person calling this directly cannot create
-- unbounded rows by inventing bucket names.
create or replace function mcp_rate_check(
  p_bucket          text,
  p_limit           integer,
  p_window_seconds  integer
)
returns table (allowed boolean, retry_after integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  me  uuid := auth.uid();
  ws  timestamptz;
  n   integer;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_bucket not in ('read', 'write', 'write_day') then
    raise exception 'unknown rate limit bucket %', p_bucket;
  end if;
  if p_limit < 1 or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid rate limit';
  end if;

  ws := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into mcp_rate_limits (profile_id, bucket, window_start, hits)
  values (me, p_bucket, ws, 1)
  on conflict (profile_id, bucket, window_start)
    do update set hits = mcp_rate_limits.hits + 1
  returning hits into n;

  allowed := n <= p_limit;
  retry_after := case
    when allowed then 0
    else greatest(1, ceil(extract(epoch from (ws + make_interval(secs => p_window_seconds) - now())))::integer)
  end;
  return next;
end;
$$;

-- Old windows are dead weight. The daily cron calls this with the service role.
create or replace function prune_mcp_rate_limits()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  delete from mcp_rate_limits where window_start < now() - interval '2 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Supabase also grants EXECUTE to `anon` by default (see 0015), so revoke it
-- explicitly. The limiter is for signed-in people; pruning is service_role only.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'domestic_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function prune_mcp_rate_limits() from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function mcp_rate_check(text, integer, integer) from anon;
  end if;
end $$;

revoke execute on function mcp_rate_check(text, integer, integer) from public;
revoke execute on function prune_mcp_rate_limits() from public;

do $$
declare r text;
begin
  foreach r in array array['authenticated', 'domestic_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function mcp_rate_check(text, integer, integer) to %I', r);
    end if;
  end loop;
end $$;
