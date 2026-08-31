-- Every house runs differently. A household turns components on and off
-- instead of inheriting whatever 526 Detroit St. happens to do.
--
-- The registry itself lives in TypeScript (src/lib/modules.ts) — this table
-- only records which keys a household has enabled and any per-module settings,
-- so adding a module is a code change, not a migration.

create table if not exists household_modules (
  household_id uuid    not null references households(id) on delete cascade,
  module       text    not null,
  enabled      boolean not null default true,
  settings     jsonb   not null default '{}',
  updated_at   timestamptz not null default now(),
  updated_by   uuid references profiles(id) on delete set null,
  primary key (household_id, module)
);

alter table household_modules enable row level security;

drop policy if exists mod_read on household_modules;
create policy mod_read on household_modules for select
  using (is_household_member(household_id));

-- Writes go through set_module() so the admin check lives in one place.
create or replace function set_module(
  p_module   text,
  p_enabled  boolean,
  p_settings jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare hh uuid;
begin
  if not is_household_admin() then
    raise exception 'only an admin can change what this household uses';
  end if;

  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  insert into household_modules (household_id, module, enabled, settings, updated_by)
  values (hh, p_module, p_enabled, coalesce(p_settings, '{}'::jsonb), auth.uid())
  on conflict (household_id, module) do update
    set enabled    = excluded.enabled,
        settings   = coalesce(p_settings, household_modules.settings),
        updated_at = now(),
        updated_by = auth.uid();
end;
$$;

-- A household with no row for a module falls back to this. Keeping the default
-- in one function means an existing household picks up a newly shipped module
-- without a backfill.
create or replace function default_modules()
returns text[]
language sql
immutable
as $$
  select array['chores', 'expenses', 'kiosk'];
$$;

create or replace function enabled_modules(p_household uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    array_agg(m.module order by m.module) filter (where m.enabled),
    '{}'::text[]
  ) || (
    -- defaults that have never been explicitly toggled
    select coalesce(array_agg(d order by d), '{}'::text[])
    from unnest(default_modules()) d
    where not exists (
      select 1 from household_modules x
      where x.household_id = p_household and x.module = d
    )
  )
  from household_modules m
  where m.household_id = p_household;
$$;

-- New households start with the defaults written explicitly, so the admin
-- screen shows real toggles rather than implied state.
--
-- `create or replace` cannot add a parameter, even a defaulted one — it creates
-- an overload, and every existing 5-argument call then fails as ambiguous. Drop
-- the 0004 signature first.
drop function if exists create_household(text, text, text, text, text);

-- `or replace` so this file can be applied twice without erroring; the drop
-- above removes the 0004 five-argument signature, not this one.
create or replace function create_household(
  p_name      text,
  p_address   text default null,
  p_timezone  text default 'America/Detroit',
  p_full_name text default null,
  p_initials  text default null,
  p_modules   text[] default null
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

  insert into households (name, address, timezone)
  values (trim(p_name), nullif(trim(coalesce(p_address, '')), ''), p_timezone)
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

  -- Anything asked for that is not a default (a module shipped later) still
  -- gets recorded.
  insert into household_modules (household_id, module, enabled, updated_by)
  select new_id, w, true, me
  from unnest(wanted) w
  where not (w = any (default_modules()))
  on conflict do nothing;

  -- Starter chores only if this house actually does chores here.
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

-- Backfill: households that predate this table keep everything they had.
insert into household_modules (household_id, module, enabled)
select h.id, d, true
from households h, unnest(default_modules()) d
on conflict do nothing;
