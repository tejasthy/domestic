-- Away status + "pass to next person" as an alternative to "skip the task
-- altogether".
--
-- `skip_turn` (0018) only ever meant "cancel this occurrence". This adds:
--   - member_away: an events table (not columns on profiles) recording who
--     was away when. Kept as history, never overwritten, because
--     resync_pending_turns/materialize_schedule judge a turn against its own
--     due_at, not "right now" -- a later trip must not corrupt the recorded
--     bounds of an earlier one while turns from that earlier window are
--     still pending.
--   - rotation_assignee gains a p_at parameter and skips away members,
--     returning null (pause, no naive fallback) when everyone in the
--     rotation is away at that instant.
--   - pass_turn: reassign the current turn to the next available person,
--     same due date, same turn_number -- distinct from skip_turn.

/* -------------------------------------------------------------- schema */

create table if not exists member_away (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references profiles(id) on delete cascade,
  household_id uuid not null references households(id) on delete cascade,
  starts_at    timestamptz not null default now(),
  ends_at      timestamptz,              -- null = indefinite, until cleared
  created_at   timestamptz not null default now()
);

create index if not exists member_away_profile_id_idx on member_away (profile_id, starts_at, ends_at);
create index if not exists member_away_household_id_idx on member_away (household_id);

alter table member_away enable row level security;

drop policy if exists member_away_read on member_away;
create policy member_away_read on member_away for select
  using (is_household_member(household_id));

/* ------------------------------------------------------------- helpers */

create or replace function is_away_at(p_profile uuid, p_at timestamptz default now())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from member_away
    where profile_id = p_profile
      and starts_at <= p_at
      and (ends_at is null or p_at < ends_at)
  );
$$;

/* ------------------------------------------------------------ rotation */

-- Cannot `create or replace` a new parameter onto an existing signature --
-- it creates an ambiguous overload. Drop the old one first.
drop function if exists rotation_assignee(uuid, integer);

create or replace function rotation_assignee(p_chore uuid, p_turn integer, p_at timestamptz default now())
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n    int;
  base int;
  cand uuid;
begin
  select count(*) into n from chore_rotation where chore_rotation.chore_id = p_chore;
  if n = 0 then
    return null;
  end if;

  base := p_turn % n;
  for i in 0..n - 1 loop
    select profile_id into cand
    from chore_rotation
    where chore_rotation.chore_id = p_chore
      and chore_rotation.position = (base + i) % n;
    if not is_away_at(cand, p_at) then
      return cand;
    end if;
  end loop;

  -- Everyone in the rotation is away at p_at: pause, don't assign anyone.
  return null;
end;
$$;

-- Pass the turn's own due date through, so append_turn judges away-ness
-- against the day the turn actually falls on, not the moment it's created.
create or replace function append_turn(p_chore uuid, p_due timestamptz default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  next_no  int;
  who      uuid;
  hh       uuid;
  new_turn chore_turns;
begin
  select household_id into hh from chores where id = p_chore;
  select coalesce(max(turn_number), -1) + 1 into next_no
    from chore_turns where chore_id = p_chore;

  who := rotation_assignee(p_chore, next_no, coalesce(p_due, now()));
  if who is null then
    return null;
  end if;

  insert into chore_turns (chore_id, household_id, turn_number, assignee_id, due_at)
  values (p_chore, hh, next_no, who, p_due)
  returning * into new_turn;

  return new_turn;
end;
$$;

-- append_turn already returns null (and inserts nothing) when nobody's
-- available, but the old loop kept counting `made` regardless -- fix the
-- miscount so a fully-away rotation reports (and does) zero top-up.
create or replace function top_up_queue(p_chore uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  want     int;
  have     int;
  made     int := 0;
  new_turn chore_turns;
begin
  select queue_depth into want from chores where id = p_chore and cadence = 'on_demand';
  if want is null then
    return 0;
  end if;

  select count(*) into have
    from chore_turns where chore_id = p_chore and status = 'pending';

  while have + made < want loop
    new_turn := append_turn(p_chore, null);
    -- Row composites are only NULL when *every* field is null, and a real
    -- turn has non-null fields alongside null ones (completed_at, etc), so
    -- check a definitely-non-null scalar field rather than the whole row.
    exit when new_turn.id is null;
    made := made + 1;
  end loop;

  return made;
end;
$$;

-- Same latent miscount as top_up_queue above: `made` was incremented for
-- every day that matched cadence, whether or not append_turn actually
-- inserted anything. A fully-away day must both create nothing AND not be
-- counted as created -- otherwise a fully-away rotation looks like it
-- materialized turns it didn't.
create or replace function materialize_schedule(p_chore uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c        chores%rowtype;
  tz       text;
  cursor_d date;
  last_d   date;
  horizon  date;
  made     int := 0;
  wk_off   int;
  anchor_w date;
  new_turn chore_turns;
begin
  select * into c from chores where id = p_chore and cadence = 'scheduled' and is_active;
  if not found or array_length(c.days_of_week, 1) is null then
    return 0;
  end if;

  select timezone into tz from households where id = c.household_id;
  horizon  := (now() at time zone tz)::date + c.lookahead_days;
  anchor_w := date_trunc('week', c.anchor_date)::date;   -- Monday-based

  -- resume after the furthest turn we already created
  select max((due_at at time zone tz)::date) into last_d
    from chore_turns where chore_id = p_chore;

  cursor_d := greatest(
    coalesce(last_d + 1, c.anchor_date),
    (now() at time zone tz)::date
  );

  while cursor_d <= horizon loop
    wk_off := ((date_trunc('week', cursor_d)::date - anchor_w) / 7)::int;
    if (extract(dow from cursor_d)::smallint = any (c.days_of_week))
       and (wk_off % greatest(c.interval_weeks, 1) = 0) then
      new_turn := append_turn(
        p_chore,
        ((cursor_d + make_interval(hours => c.due_hour)) at time zone tz)
      );
      -- Same row-composite gotcha as top_up_queue above: IS NOT NULL on a
      -- row requires *every* field to be non-null, which a real (partially
      -- null) turn never satisfies. Check a definitely-non-null field.
      if new_turn.id is not null then
        made := made + 1;
      end if;
    end if;
    cursor_d := cursor_d + 1;
  end loop;

  return made;
end;
$$;

-- Due-date aware, and handles the "nobody available" case: assignee_id is
-- not null, so a turn nobody can be assigned to gets auto-skipped (logged)
-- instead of reassigned to null.
create or replace function resync_pending_turns(p_chore uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  touched int := 0;
  t       record;
  next_id uuid;
  c       chores%rowtype;
begin
  select * into c from chores where id = p_chore;

  for t in
    select * from chore_turns where chore_id = p_chore and status = 'pending' for update
  loop
    next_id := rotation_assignee(t.chore_id, t.turn_number, coalesce(t.due_at, now()));

    if next_id is null then
      update chore_turns
         set status = 'skipped', completed_at = now(),
             note = coalesce(note, 'everyone was away')
       where id = t.id;

      insert into activity_log (household_id, actor_id, verb, summary, metadata)
      values (t.household_id, null, 'skipped_chore',
              c.name || ' skipped — everyone was away',
              jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji));

      touched := touched + 1;
    elsif next_id is distinct from t.assignee_id then
      update chore_turns set assignee_id = next_id where id = t.id;
      touched := touched + 1;
    end if;
  end loop;

  return touched;
end;
$$;

/* ------------------------------------------------------------ away RPCs */

create or replace function set_away(p_until timestamptz default null)
returns member_away
language plpgsql
security definer
set search_path = public
as $$
declare
  me   uuid := auth.uid();
  hh   uuid;
  name text;
  row  member_away%rowtype;
  c    record;
begin
  select household_id, full_name into hh, name from profiles where id = me;
  if hh is null then raise exception 'you are not in a household'; end if;

  update member_away
     set ends_at = now()
   where profile_id = me
     and starts_at <= now()
     and (ends_at is null or now() < ends_at);

  insert into member_away (profile_id, household_id, ends_at)
  values (me, hh, p_until)
  returning * into row;

  for c in select id, cadence from chores where household_id = hh and is_active loop
    perform resync_pending_turns(c.id);
    if c.cadence = 'on_demand' then
      perform top_up_queue(c.id);
    end if;
  end loop;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (hh, me, 'set_away',
          name || ' is away' || case when p_until is not null
            then ' until ' || to_char(p_until, 'Mon DD') else '' end,
          jsonb_build_object('until', p_until));

  return row;
end;
$$;

create or replace function clear_away()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me   uuid := auth.uid();
  hh   uuid;
  name text;
  c    record;
begin
  select household_id, full_name into hh, name from profiles where id = me;
  if hh is null then raise exception 'you are not in a household'; end if;

  update member_away
     set ends_at = now()
   where profile_id = me
     and starts_at <= now()
     and (ends_at is null or now() < ends_at);

  for c in select id, cadence from chores where household_id = hh and is_active loop
    perform resync_pending_turns(c.id);
    if c.cadence = 'on_demand' then
      perform top_up_queue(c.id);
    end if;
  end loop;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (hh, me, 'cleared_away', name || ' is back', '{}'::jsonb);
end;
$$;

/* --------------------------------------------------------------- pass */

-- "Pass to the next person" -- distinct from skip_turn: keeps the same
-- turn_number/due_at/status, just moves the baton to whoever's next in the
-- rotation (skipping anyone away). Raises rather than falling back to skip
-- when nobody else is available, so the caller explicitly chooses skip_turn
-- instead in that case.
create or replace function pass_turn(p_turn uuid, p_note text default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t          chore_turns%rowtype;
  c          chores%rowtype;
  me         uuid := auth.uid();
  allow_cross boolean;
  n          int;
  cur_pos    int;
  at         timestamptz;
  next_id    uuid;
  cand       uuid;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then raise exception 'turn not found'; end if;
  if not is_household_member(t.household_id) then raise exception 'not your household'; end if;
  if t.status <> 'pending' then raise exception 'that turn is not pending'; end if;

  if me is distinct from t.assignee_id then
    select allow_member_cross_complete into allow_cross from households where id = t.household_id;
    if not coalesce(allow_cross, false) then
      raise exception 'only the assigned member can pass this — an admin can let anyone act for anyone in Settings';
    end if;
  end if;

  select count(*) into n from chore_rotation where chore_id = t.chore_id;
  if n <= 1 then
    raise exception 'no one else in the rotation to pass to';
  end if;

  select position into cur_pos from chore_rotation
   where chore_id = t.chore_id and profile_id = t.assignee_id;
  at := coalesce(t.due_at, now());

  if cur_pos is not null then
    for i in 1..n - 1 loop
      select profile_id into cand
      from chore_rotation
      where chore_id = t.chore_id and position = (cur_pos + i) % n;
      if not is_away_at(cand, at) then
        next_id := cand;
        exit;
      end if;
    end loop;
  end if;

  if next_id is null then
    raise exception 'everyone else is away — skip the task instead';
  end if;

  update chore_turns
     set assignee_id = next_id, note = coalesce(p_note, note)
   where id = p_turn
   returning * into t;

  select * into c from chores where id = t.chore_id;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me, 'passed_chore',
         p.full_name || ' passed ' || c.name || ' to ' || nx.full_name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p, profiles nx
  where p.id = coalesce(me, t.assignee_id) and nx.id = next_id;

  return t;
end;
$$;
