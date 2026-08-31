-- Kiosk interactivity: tap-to-act on the wall display, an admin-gated toggle
-- letting any member complete anyone's chore, a household weather location,
-- and short-lived notes that show up on the kiosk.
--
-- The kiosk has no auth.uid() — it authenticates by device token, resolved to
-- a household id in application code (src/lib/kiosk.ts). Every kiosk_* RPC
-- below takes that household id plus an explicit "acting as" profile id
-- instead of reading auth.uid(), and validates against the household rather
-- than a session. Because these skip the auth.uid()-based ownership checks
-- the non-kiosk RPCs use, they are locked to service_role only — callable
-- exclusively from server actions that already resolved and validated the
-- kiosk's household, never directly by a signed-in user (who could otherwise
-- pass any housemate's profile id and bypass allow_member_cross_complete
-- entirely).

/* ------------------------------------------------------------- households */

alter table households
  add column if not exists allow_member_cross_complete boolean not null default false,
  add column if not exists location_label text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

create or replace function set_cross_complete(p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare hh uuid;
begin
  if not is_household_admin() then
    raise exception 'only an admin can change who can complete whose chores';
  end if;
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  update households set allow_member_cross_complete = p_enabled where id = hh;
end;
$$;

create or replace function set_household_location(
  p_label text,
  p_lat   double precision,
  p_lon   double precision
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare hh uuid;
begin
  if not is_household_admin() then
    raise exception 'only an admin can set the household location';
  end if;
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  update households
     set location_label = nullif(trim(coalesce(p_label, '')), ''),
         latitude        = p_lat,
         longitude       = p_lon
   where id = hh;
end;
$$;

/* ---------------------------------------------------- cross-user completion */

-- Same body as before, plus one gate: completing someone else's turn now
-- requires the household to have turned that on. `me`/`completed_by` are
-- unchanged — still whoever actually tapped the button, never the assignee.
create or replace function complete_turn(p_turn uuid, p_note text default null)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t           chore_turns%rowtype;
  c           chores%rowtype;
  me          uuid := auth.uid();
  allow_cross boolean;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then
    raise exception 'turn not found';
  end if;
  if not is_household_member(t.household_id) then
    raise exception 'not your household';
  end if;
  if t.status = 'done' then
    return t;
  end if;

  if me is distinct from t.assignee_id then
    select allow_member_cross_complete into allow_cross
    from households where id = t.household_id;
    if not coalesce(allow_cross, false) then
      raise exception 'only the assigned member can complete this — an admin can let anyone complete anyone''s chores in Settings';
    end if;
  end if;

  update chore_turns
     set status = 'done', completed_at = now(), completed_by = coalesce(me, t.assignee_id), note = p_note
   where id = p_turn
  returning * into t;

  select * into c from chores where id = t.chore_id;

  if c.cadence = 'on_demand' then
    perform top_up_queue(t.chore_id);
  else
    perform materialize_schedule(t.chore_id);
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, coalesce(me, t.assignee_id), 'completed_chore',
         p.full_name || ' did ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = coalesce(me, t.assignee_id);

  return t;
end;
$$;

/* --------------------------------------------------------------- kiosk RPCs */

create or replace function kiosk_complete_turn(
  p_household uuid,
  p_turn      uuid,
  p_profile   uuid,
  p_note      text default null
)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t chore_turns%rowtype;
  c chores%rowtype;
begin
  if not exists (select 1 from profiles where id = p_profile and household_id = p_household) then
    raise exception 'not a member of this household';
  end if;

  select * into t from chore_turns where id = p_turn and household_id = p_household for update;
  if not found then raise exception 'turn not found'; end if;
  if t.status = 'done' then return t; end if;

  update chore_turns
     set status = 'done', completed_at = now(), completed_by = p_profile, note = p_note
   where id = p_turn
  returning * into t;

  select * into c from chores where id = t.chore_id;

  if c.cadence = 'on_demand' then
    perform top_up_queue(t.chore_id);
  else
    perform materialize_schedule(t.chore_id);
  end if;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, p_profile, 'completed_chore',
         p.full_name || ' did ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = p_profile;

  return t;
end;
$$;

create or replace function kiosk_flag_chore(
  p_household uuid,
  p_chore     uuid,
  p_profile   uuid
)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t chore_turns%rowtype;
  c chores%rowtype;
begin
  if not exists (select 1 from profiles where id = p_profile and household_id = p_household) then
    raise exception 'not a member of this household';
  end if;

  select * into c from chores where id = p_chore and household_id = p_household;
  if not found then raise exception 'chore not found'; end if;

  perform top_up_queue(p_chore);

  select * into t from chore_turns
   where chore_id = p_chore and status = 'pending'
   order by turn_number limit 1;

  update chore_turns set due_at = now() where id = t.id and due_at is null;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select c.household_id, p_profile, 'flagged_chore',
         c.name || ' needs doing',
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji);

  return t;
end;
$$;

-- Kiosk treats swap approval as an admin action rather than routing it to
-- the specific person the swap was addressed to — the wall display's "acting
-- as" model is coarser than the app's per-recipient swap flow, so it uses the
-- same admin gate as kiosk_set_chore_active instead of checking requested_to.
create or replace function kiosk_respond_swap(
  p_household uuid,
  p_swap      uuid,
  p_profile   uuid,
  p_accept    boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s chore_swaps%rowtype;
begin
  if not exists (
    select 1 from profiles
    where id = p_profile and household_id = p_household and is_admin
  ) then
    raise exception 'only an admin can do that';
  end if;

  select s.* into s
  from chore_swaps s
  join chore_turns t on t.id = s.turn_id
  where s.id = p_swap and t.household_id = p_household
  for update of s;
  if not found or s.status <> 'pending' then
    raise exception 'swap not open';
  end if;

  if p_accept then
    update chore_turns set assignee_id = s.requested_to where id = s.turn_id;
    update chore_swaps set status = 'accepted', resolved_at = now() where id = p_swap;
  else
    update chore_swaps set status = 'declined', resolved_at = now() where id = p_swap;
  end if;
end;
$$;

create or replace function kiosk_set_chore_active(
  p_household uuid,
  p_chore     uuid,
  p_profile   uuid,
  p_active    boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare chore chores%rowtype;
begin
  if not exists (
    select 1 from profiles
    where id = p_profile and household_id = p_household and is_admin
  ) then
    raise exception 'only an admin can do that';
  end if;

  update chores set is_active = p_active
   where id = p_chore and household_id = p_household
  returning * into chore;
  if not found then raise exception 'that chore is not in this household'; end if;

  if p_active then
    if chore.cadence = 'scheduled' then
      perform materialize_schedule(p_chore);
    else
      perform top_up_queue(p_chore);
    end if;
  end if;
end;
$$;

-- Lock the kiosk_* functions to service_role: revoke the default PUBLIC
-- execute grant every function gets, plus the per-role default privilege the
-- app role picks up on creation (see supabase/tests/run.sh), then grant back
-- only to service_role — the role createAdminClient() authenticates as.
do $$
declare r text;
begin
  foreach r in array array['authenticated', 'domestic_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function kiosk_complete_turn(uuid, uuid, uuid, text) from %I', r);
      execute format('revoke execute on function kiosk_flag_chore(uuid, uuid, uuid) from %I', r);
      execute format('revoke execute on function kiosk_respond_swap(uuid, uuid, uuid, boolean) from %I', r);
      execute format('revoke execute on function kiosk_set_chore_active(uuid, uuid, uuid, boolean) from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function kiosk_complete_turn(uuid, uuid, uuid, text) to service_role;
    grant execute on function kiosk_flag_chore(uuid, uuid, uuid) to service_role;
    grant execute on function kiosk_respond_swap(uuid, uuid, uuid, boolean) to service_role;
    grant execute on function kiosk_set_chore_active(uuid, uuid, uuid, boolean) to service_role;
  end if;
end $$;

revoke execute on function kiosk_complete_turn(uuid, uuid, uuid, text) from public;
revoke execute on function kiosk_flag_chore(uuid, uuid, uuid) from public;
revoke execute on function kiosk_respond_swap(uuid, uuid, uuid, boolean) from public;
revoke execute on function kiosk_set_chore_active(uuid, uuid, uuid, boolean) from public;

/* ------------------------------------------------------------- kiosk notes */

create table if not exists kiosk_messages (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) on delete cascade,
  author_id    uuid references profiles(id) on delete set null,
  body         text not null check (char_length(trim(body)) > 0 and char_length(body) <= 280),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '48 hours'
);

create index if not exists kiosk_messages_household_id_expires_at_idx
  on kiosk_messages (household_id, expires_at);

alter table kiosk_messages enable row level security;

drop policy if exists kiosk_messages_all on kiosk_messages;
create policy kiosk_messages_all on kiosk_messages for all
  using (is_household_member(household_id))
  with check (is_household_member(household_id) and author_id = auth.uid());
