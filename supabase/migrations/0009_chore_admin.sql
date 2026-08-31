-- Chores were seed-only: create_household() inserts a starter set and nothing
-- since then has let an admin add, edit, or retire one. This gives admins the
-- same "add/remove" power over chores that already exists for people
-- (household_invites, remove_member) and devices (kiosk_devices).
--
-- Precedent: household_invites and kiosk_devices carry only a SELECT policy —
-- writes are impossible except through a SECURITY DEFINER function that checks
-- is_household_admin() internally. `chores`/`chore_rotation` currently allow
-- any member to write directly (`ch_all`/`rot_all`), but nothing in the app
-- ever does — every client reference is a `.select(...)`. Tightening both
-- tables to the same read-only-plus-RPC shape closes that gap and gives chore
-- management the same admin boundary as everything else in this tier.

/* ------------------------------------------------------------------ create */

create or replace function create_chore(
  p_name           text,
  p_cadence        chore_cadence,
  p_emoji          text default '🧹',
  p_description    text default null,
  p_days_of_week   smallint[] default '{}',
  p_interval_weeks smallint default 1,
  p_due_hour       smallint default 20,
  p_queue_depth    smallint default 4,
  p_lookahead_days smallint default 21,
  p_profile_ids    uuid[] default '{}'
)
returns chores
language plpgsql
security definer
set search_path = public
as $$
declare
  hh        uuid;
  next_sort smallint;
  new_chore chores%rowtype;
begin
  if not is_household_admin() then raise exception 'only an admin can add a chore'; end if;
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'give it a name'; end if;

  select coalesce(max(sort_order), 0) + 1 into next_sort from chores where household_id = hh;

  insert into chores (
    household_id, name, emoji, description, cadence,
    days_of_week, interval_weeks, due_hour, queue_depth, lookahead_days, sort_order
  )
  values (
    hh, trim(p_name), coalesce(nullif(trim(p_emoji), ''), '🧹'),
    nullif(trim(coalesce(p_description, '')), ''), p_cadence,
    coalesce(p_days_of_week, '{}'), greatest(coalesce(p_interval_weeks, 1), 1),
    coalesce(p_due_hour, 20), greatest(coalesce(p_queue_depth, 4), 1),
    greatest(coalesce(p_lookahead_days, 21), 1), next_sort
  )
  returning * into new_chore;

  if p_profile_ids is not null and array_length(p_profile_ids, 1) is not null then
    insert into chore_rotation (chore_id, profile_id, position)
    select new_chore.id, t.pid, t.ord - 1
    from unnest(p_profile_ids) with ordinality as t(pid, ord)
    where exists (select 1 from profiles where id = t.pid and household_id = hh);
  end if;

  if new_chore.cadence = 'scheduled' then
    perform materialize_schedule(new_chore.id);
  else
    perform top_up_queue(new_chore.id);
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  values (hh, auth.uid(), 'created_chore', new_chore.name || ' was added to the board',
          jsonb_build_object('chore_id', new_chore.id, 'emoji', new_chore.emoji));

  return new_chore;
end;
$$;

/* -------------------------------------------------------------------- edit */

-- Cadence-affecting fields only touch `pending` turns — done/skipped/missed
-- rows are history and are never rewritten, same rule as resync_pending_turns.
create or replace function update_chore(
  p_chore          uuid,
  p_name           text default null,
  p_emoji          text default null,
  p_description    text default null,
  p_cadence        chore_cadence default null,
  p_days_of_week   smallint[] default null,
  p_interval_weeks smallint default null,
  p_due_hour       smallint default null,
  p_queue_depth    smallint default null,
  p_lookahead_days smallint default null,
  p_sort_order     smallint default null
)
returns chores
language plpgsql
security definer
set search_path = public
as $$
declare
  hh              uuid;
  before          chores%rowtype;
  after           chores%rowtype;
  cadence_changed boolean;
begin
  if not is_household_admin() then raise exception 'only an admin can edit a chore'; end if;
  select household_id into hh from profiles where id = auth.uid();

  select * into before from chores where id = p_chore and household_id = hh;
  if not found then raise exception 'that chore is not in your household'; end if;

  update chores set
    name           = coalesce(nullif(trim(p_name), ''), name),
    emoji          = coalesce(nullif(trim(p_emoji), ''), emoji),
    description    = case when p_description is not null
                          then nullif(trim(p_description), '') else description end,
    cadence        = coalesce(p_cadence, cadence),
    days_of_week   = coalesce(p_days_of_week, days_of_week),
    interval_weeks = coalesce(p_interval_weeks, interval_weeks),
    due_hour       = coalesce(p_due_hour, due_hour),
    queue_depth    = coalesce(p_queue_depth, queue_depth),
    lookahead_days = coalesce(p_lookahead_days, lookahead_days),
    sort_order     = coalesce(p_sort_order, sort_order)
  where id = p_chore
  returning * into after;

  cadence_changed :=
    after.cadence        is distinct from before.cadence or
    after.days_of_week   is distinct from before.days_of_week or
    after.interval_weeks is distinct from before.interval_weeks or
    after.due_hour       is distinct from before.due_hour or
    after.queue_depth    is distinct from before.queue_depth;

  if cadence_changed then
    delete from chore_turns where chore_id = p_chore and status = 'pending';
    if after.cadence = 'scheduled' then
      perform materialize_schedule(p_chore);
    else
      perform top_up_queue(p_chore);
    end if;
  end if;

  return after;
end;
$$;

/* ------------------------------------------------------------ active state */

-- One toggle covers both directions: deactivating hides a chore from the
-- board without touching its history (chore_turns still references it);
-- reactivating just needs the queue/schedule filled back in.
create or replace function set_chore_active(p_chore uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  hh     uuid;
  chore  chores%rowtype;
begin
  if not is_household_admin() then raise exception 'only an admin can do that'; end if;
  select household_id into hh from profiles where id = auth.uid();

  update chores set is_active = p_active
   where id = p_chore and household_id = hh
  returning * into chore;
  if not found then raise exception 'that chore is not in your household'; end if;

  if p_active then
    if chore.cadence = 'scheduled' then
      perform materialize_schedule(p_chore);
    else
      perform top_up_queue(p_chore);
    end if;
  end if;
end;
$$;

/* --------------------------------------------------------------- rotation */

-- Replaces a chore's entire roster in one call — add, remove, and reorder are
-- all just "submit the new ordered list", so the UI needs one primitive
-- instead of three. Positions come straight from the submitted array's order
-- (via `with ordinality`), which is simpler than deriving them from existing
-- row order the way remove_from_rotations does for a single deletion.
create or replace function set_chore_rotation(p_chore uuid, p_profile_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare hh uuid;
begin
  if not is_household_admin() then raise exception 'only an admin can edit a chore roster'; end if;
  select household_id into hh from profiles where id = auth.uid();
  if not exists (select 1 from chores where id = p_chore and household_id = hh) then
    raise exception 'that chore is not in your household';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_profile_ids, '{}')) pid
    where not exists (select 1 from profiles where id = pid and household_id = hh)
  ) then
    raise exception 'everyone on the rotation must be in your household';
  end if;

  delete from chore_rotation where chore_id = p_chore;

  insert into chore_rotation (chore_id, profile_id, position)
  select p_chore, t.pid, t.ord - 1
  from unnest(coalesce(p_profile_ids, '{}')) with ordinality as t(pid, ord);

  perform resync_pending_turns(p_chore);
end;
$$;

/* --------------------------------------------------------------------- RLS */

drop policy if exists ch_all on chores;
drop policy if exists ch_read on chores;
create policy ch_read on chores for select
  using (is_household_member(household_id));

drop policy if exists rot_all on chore_rotation;
drop policy if exists rot_read on chore_rotation;
create policy rot_read on chore_rotation for select
  using (exists (select 1 from chores c where c.id = chore_id and is_household_member(c.household_id)));
