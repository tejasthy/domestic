-- Get ahead / defer: two personal, self-only escape hatches for someone who
-- knows they'll be busy. Neither one reassigns or reorders anyone else's
-- turn — get_ahead completes your own next turn early; defer pushes your own
-- turn's due date later. Both are rate-limited (default: 2 "ahead"/deferred
-- at a time, 1 use per rolling 30 days) to keep them from being used to
-- dodge the rotation outright, admin-configurable, on by default, and
-- admin-disableable.
--
-- Config lives in household_modules.settings under a new module key
-- 'get_ahead' — deliberately not added to src/lib/modules.ts's page-having
-- registry, since household_modules/set_module are already generic by
-- design (CLAUDE.md calls the unused `settings` jsonb column exactly the
-- right home for this). "No row for this household" means enabled — safe
-- because 'get_ahead' is not in default_modules(), so create_household()
-- never inserts a `false` row for it.

create table if not exists chore_advance_log (
  id         uuid primary key default gen_random_uuid(),
  chore_id   uuid not null references chores(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  kind       text not null check (kind in ('get_ahead', 'defer')),
  turn_id    uuid not null references chore_turns(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists chore_advance_log_chore_profile_kind_idx
  on chore_advance_log (chore_id, profile_id, kind, created_at desc);
create index if not exists chore_advance_log_turn_id_idx on chore_advance_log (turn_id);

alter table chore_advance_log enable row level security;

drop policy if exists advance_log_read on chore_advance_log;
create policy advance_log_read on chore_advance_log for select
  using (exists (select 1 from chores c where c.id = chore_id and is_household_member(c.household_id)));
-- No insert/update/delete policy: writes only through get_ahead()/defer_turn() below.

/* -------------------------------------------------------------- helpers */

-- Mirrors materialize_schedule's own day/interval matching rule, kept as a
-- standalone function rather than reusing materialize_schedule itself, so
-- this feature can't risk regressing that function's tested loop.
create or replace function next_scheduled_date(p_chore uuid, p_after date)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c        chores%rowtype;
  cursor_d date;
  anchor_w date;
  wk_off   int;
begin
  select * into c from chores where id = p_chore and cadence = 'scheduled';
  if not found or array_length(c.days_of_week, 1) is null then
    return null;
  end if;

  anchor_w := date_trunc('week', c.anchor_date)::date;
  cursor_d := p_after + 1;

  loop
    wk_off := ((date_trunc('week', cursor_d)::date - anchor_w) / 7)::int;
    if (extract(dow from cursor_d)::smallint = any (c.days_of_week))
       and (wk_off % greatest(c.interval_weeks, 1) = 0) then
      return cursor_d;
    end if;
    cursor_d := cursor_d + 1;
  end loop;
end;
$$;

/* ------------------------------------------------------------- get_ahead */

-- Standing chores are excluded: get-ahead's only possible implementation
-- would require more than one simultaneously-pending turn on a chore whose
-- entire model is "exactly one pending turn at a time" — pass_turn is
-- already the right release valve there.
create or replace function get_ahead(p_chore uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  me          uuid := auth.uid();
  c           chores%rowtype;
  n           int;
  mod_enabled boolean;
  mod_settings jsonb;
  max_ahead   int;
  max_per_30d int;
  cursor_no   int;
  ahead_count int;
  uses_30d    int;
  target      chore_turns%rowtype;
  tz          text;
  next_due    date;
  last_due    date;
  iterations  int := 0;
  cap         constant int := 500;
begin
  select * into c from chores where id = p_chore;
  if not found then raise exception 'chore not found'; end if;
  if not is_household_member(c.household_id) then raise exception 'not your household'; end if;
  if c.cadence = 'standing' then
    raise exception 'get-ahead does not apply to standing chores — pass it on if you cannot get to it';
  end if;
  if not exists (select 1 from chore_rotation where chore_id = p_chore and profile_id = me) then
    raise exception 'you are not in this chore''s rotation';
  end if;

  select enabled, settings into mod_enabled, mod_settings
    from household_modules where household_id = c.household_id and module = 'get_ahead';
  if not coalesce(mod_enabled, true) then raise exception 'get-ahead is turned off for this house'; end if;
  mod_settings := coalesce(mod_settings, '{}'::jsonb);
  max_ahead   := coalesce((mod_settings #>> '{get_ahead,max_ahead}')::int, 2);
  max_per_30d := coalesce((mod_settings #>> '{get_ahead,max_per_30d}')::int, 1);

  select count(*) into uses_30d from chore_advance_log
   where chore_id = p_chore and profile_id = me and kind = 'get_ahead'
     and created_at > now() - interval '30 days';
  if uses_30d >= max_per_30d then
    raise exception 'You have used get-ahead % time(s) in the last 30 days — the house limit is %.', uses_30d, max_per_30d;
  end if;

  -- "Already N ahead" = N of your get_ahead completions still sit beyond the
  -- chore's current pending frontier. This self-resolves as the rotation
  -- naturally catches up to and past those turns — no reset job needed.
  select case when min(turn_number) is null
           then (select coalesce(max(turn_number), -1) from chore_turns where chore_id = p_chore)
           else min(turn_number) - 1 end
    into cursor_no
  from chore_turns where chore_id = p_chore and status = 'pending';

  select count(*) into ahead_count
  from chore_advance_log l join chore_turns t on t.id = l.turn_id
  where l.chore_id = p_chore and l.profile_id = me and l.kind = 'get_ahead' and t.turn_number > cursor_no;
  if ahead_count >= max_ahead then
    raise exception 'You are already % turn(s) ahead on this chore — let the rotation catch up first.', max_ahead;
  end if;

  -- Common case: you already have a pending turn of your own materialized.
  select * into target from chore_turns
   where chore_id = p_chore and status = 'pending' and assignee_id = me
   order by turn_number limit 1;

  if not found then
    -- Rare case: walk forward, materializing turns as we go, until we reach
    -- one that lands on you. Bounded so an unreachable rotation (nobody
    -- assignable) can't loop forever.
    select count(*) into n from chore_rotation where chore_id = p_chore;
    if n = 0 then raise exception 'this chore has no rotation'; end if;

    if c.cadence = 'scheduled' then
      select timezone into tz from households where id = c.household_id;
      select coalesce(max((due_at at time zone tz)::date), c.anchor_date - 1) into last_due
        from chore_turns where chore_id = p_chore;
      loop
        iterations := iterations + 1;
        exit when iterations > cap;
        next_due := next_scheduled_date(p_chore, last_due);
        exit when next_due is null;
        target := append_turn(p_chore, (next_due + make_interval(hours => c.due_hour)) at time zone tz);
        last_due := next_due;
        exit when target.id is not null and target.assignee_id = me;
      end loop;
    else
      loop
        iterations := iterations + 1;
        exit when iterations > cap;
        target := append_turn(p_chore, null);
        exit when target.id is null;
        exit when target.assignee_id = me;
      end loop;
    end if;

    if target.id is null or target.assignee_id is distinct from me then
      raise exception 'could not find an upcoming turn of yours to get ahead on';
    end if;
  end if;

  update chore_turns
     set status = 'done', completed_at = now(), completed_by = me,
         note = coalesce(note, 'Done ahead of schedule')
   where id = target.id
  returning * into target;

  -- Same post-completion top-up complete_turn does — without it, an
  -- on_demand queue would run one turn short of queue_depth after a get-ahead.
  if c.cadence = 'scheduled' then
    perform materialize_schedule(p_chore);
  else
    perform top_up_queue(p_chore);
  end if;

  insert into chore_advance_log (chore_id, profile_id, kind, turn_id)
  values (p_chore, me, 'get_ahead', target.id);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select c.household_id, me, 'got_ahead', p.full_name || ' got ahead on ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', target.id, 'emoji', c.emoji)
  from profiles p where p.id = me;

  return target;
end;
$$;

/* --------------------------------------------------------------- defer */

create or replace function defer_turn(p_turn uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  me          uuid := auth.uid();
  t           chore_turns%rowtype;
  c           chores%rowtype;
  mod_enabled boolean;
  mod_settings jsonb;
  max_defers  int;
  max_per_30d int;
  defer_count int;
  uses_30d    int;
  tz          text;
  next_due    date;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then raise exception 'turn not found'; end if;
  if not is_household_member(t.household_id) then raise exception 'not your household'; end if;
  if t.status <> 'pending' then raise exception 'that turn is not pending'; end if;
  if me is distinct from t.assignee_id then raise exception 'you can only defer your own turn'; end if;
  if t.due_at is null then raise exception 'this turn has no due date to push back'; end if;

  select * into c from chores where id = t.chore_id;
  -- Standing turns never carry a due_at, so the check above already excludes
  -- them; pass_turn is the equivalent tool there.

  select enabled, settings into mod_enabled, mod_settings
    from household_modules where household_id = c.household_id and module = 'get_ahead';
  if not coalesce(mod_enabled, true) then raise exception 'get-ahead/defer is turned off for this house'; end if;
  mod_settings := coalesce(mod_settings, '{}'::jsonb);
  max_defers  := coalesce((mod_settings #>> '{defer,max_ahead}')::int, 2);
  max_per_30d := coalesce((mod_settings #>> '{defer,max_per_30d}')::int, 1);

  select count(*) into defer_count from chore_advance_log where turn_id = p_turn and kind = 'defer';
  if defer_count >= max_defers then
    raise exception 'This turn has already been deferred % time(s) — go ahead and do it, skip it, or pass it.', max_defers;
  end if;

  select count(*) into uses_30d from chore_advance_log
   where chore_id = t.chore_id and profile_id = me and kind = 'defer'
     and created_at > now() - interval '30 days';
  if uses_30d >= max_per_30d then
    raise exception 'You have deferred % time(s) in the last 30 days — the house limit is %.', uses_30d, max_per_30d;
  end if;

  if c.cadence = 'scheduled' then
    select timezone into tz from households where id = c.household_id;
    next_due := next_scheduled_date(t.chore_id, (t.due_at at time zone tz)::date);
    if next_due is null then raise exception 'could not find a later date for this chore''s schedule'; end if;
    update chore_turns set due_at = (next_due + make_interval(hours => c.due_hour)) at time zone tz
     where id = p_turn
    returning * into t;
  else
    update chore_turns set due_at = null where id = p_turn returning * into t;
  end if;

  insert into chore_advance_log (chore_id, profile_id, kind, turn_id)
  values (t.chore_id, me, 'defer', p_turn);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me, 'deferred_chore', p.full_name || ' pushed back ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = me;

  return t;
end;
$$;
