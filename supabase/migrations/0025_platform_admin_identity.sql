-- Platform-admin identity: scaffolding for the operator (Tejas) to see
-- cross-household aggregates once other households actually use this
-- open-sourced app — today there is exactly one real household.
--
-- Two independent locks, not a `platform_admins` table:
--   * a Postgres GUC (app.platform_admin_emails), set once per deployment
--     via `alter database ... set ...` — this is the real authorization
--     boundary, since a security-definer RPC bypasses RLS entirely once
--     inside it, so it needs its own check independent of anything Next.js
--     does. See src/lib/platform-admin.ts for the matching Next.js-side gate
--     (route visibility only, not authorization) and .env.local.example for
--     the paired PLATFORM_ADMIN_EMAILS env var.
-- A DB table was considered and rejected: it's new writable schema (RLS,
-- seeding) for a problem an env var + GUC solves with zero schema footprint.
-- Passing an allowlist as an RPC argument was also rejected: it's spoofable
-- — nothing stops a caller passing their own email as "the allowlist".
--
-- If the GUC is never set (a fresh self-hosted deployment), this returns
-- false for everyone — safe by default, nothing to misconfigure into an
-- accidental opening.

create or replace function is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select lower(email) from profiles where id = auth.uid())
      = any (string_to_array(lower(coalesce(current_setting('app.platform_admin_emails', true), '')), ',')),
    false
  );
$$;

/* ------------------------------------------------------------ signup source */

-- Honest, minimal "join source": captured only when a household is created
-- (its origin), not when someone redeems an invite to join an existing one —
-- that's always "invited by a housemate," a fixed bucket needing no column.
-- No IP capture, no IP geolocation, no user-agent logging anywhere in this
-- app — the highest-regret PII categories to ship by default in code other
-- people now self-host for their own families.

alter table households add column if not exists signup_source text
  check (signup_source is null or signup_source ~ '^[a-z0-9_-]{1,40}$');

-- Cannot `create or replace` a new parameter onto an existing signature —
-- drop the 0005 six-argument version first.
drop function if exists create_household(text, text, text, text, text, text[]);

create or replace function create_household(
  p_name          text,
  p_address       text default null,
  p_timezone      text default 'America/Detroit',
  p_full_name     text default null,
  p_initials      text default null,
  p_modules       text[] default null,
  p_signup_source text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me       uuid := auth.uid();
  new_id   uuid;
  chore_id uuid;
  existing uuid;
  wanted   text[] := coalesce(p_modules, default_modules());
begin
  if me is null then
    raise exception 'not signed in';
  end if;

  select household_id into existing from profiles where id = me;
  if existing is not null then
    raise exception 'you are already in a household';
  end if;

  insert into households (name, address, timezone, signup_source)
  values (
    trim(p_name), nullif(trim(coalesce(p_address, '')), ''), p_timezone,
    nullif(trim(coalesce(p_signup_source, '')), '')
  )
  returning id into new_id;

  update profiles
     set household_id = new_id,
         is_admin     = true,
         full_name    = coalesce(nullif(trim(coalesce(p_full_name, '')), ''), full_name),
         initials     = coalesce(nullif(upper(trim(coalesce(p_initials, ''))), ''), initials)
   where id = me;

  insert into household_modules (household_id, module, enabled, updated_by)
  select new_id, d, d = any (wanted), me
  from unnest(default_modules()) d;

  insert into household_modules (household_id, module, enabled, updated_by)
  select new_id, w, true, me
  from unnest(wanted) w
  where not (w = any (default_modules()))
  on conflict do nothing;

  if 'chores' = any (wanted) then
    for chore_id in
      insert into chores (household_id, name, emoji, description, cadence,
                          days_of_week, interval_weeks, due_hour, queue_depth, sort_order)
      values
        (new_id, 'Floors', '🧹', 'Sweep and mop the common areas', 'scheduled', '{0,5}', 1, 20, 4, 1),
        (new_id, 'Microwave', '🍲', 'Wipe out the microwave', 'scheduled', '{6}', 2, 20, 4, 2),
        (new_id, 'Trash to curb', '🗑️', 'Bins out the night before pickup', 'scheduled', '{0}', 1, 19, 4, 3),
        (new_id, 'Dishes', '🍽️', 'Run and unload a load', 'on_demand', '{}', 1, 20, 4, 4),
        (new_id, 'Trash when full', '🚮', 'Swap the kitchen bag', 'on_demand', '{}', 1, 20, 4, 5)
      returning id
    loop
      insert into chore_rotation (chore_id, profile_id, position) values (chore_id, me, 0);
    end loop;

    for chore_id in select id from chores where household_id = new_id loop
      if (select cadence from chores where id = chore_id) = 'scheduled' then
        perform materialize_schedule(chore_id);
      else
        perform top_up_queue(chore_id);
      end if;
    end loop;
  end if;

  insert into activity_log (household_id, actor_id, verb, summary)
  values (new_id, me, 'created_household',
          (select full_name from profiles where id = me) || ' started the house');

  return new_id;
end;
$$;
