-- Turns Domestic from "one hardcoded house" into something any household can
-- deploy and run themselves.
--
--   * invites become shareable codes, not just pre-registered emails
--   * households are created in-app by whoever signs up first
--   * joining a household appends you to every rotation, mid-cycle, safely
--   * the kiosk is bound to a household by device record, not an env var
--   * closes a privilege escalation in the profiles update policy

/* ------------------------------------------------------------------ helpers */

create or replace function is_household_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

-- Crockford-ish alphabet: no I, L, O, U, 0 or 1, because these get read aloud
-- and typed on an iPad.
create or replace function generate_invite_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  candidate text;
  i int;
begin
  loop
    candidate := '';
    for i in 1..8 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      if i = 4 then candidate := candidate || '-'; end if;
    end loop;
    exit when not exists (select 1 from household_invites where code = candidate);
  end loop;
  return candidate;
end;
$$;

/* ------------------------------------------------------------- invite table */

-- 0003 keyed invites by email. Re-shape to a row-per-invite with a shareable
-- code; email becomes an optional restriction rather than the identity.
alter table household_invites
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists code text,
  add column if not exists created_by uuid references profiles(id) on delete set null,
  add column if not exists expires_at timestamptz,
  add column if not exists max_uses integer not null default 1,
  add column if not exists used_count integer not null default 0,
  add column if not exists revoked_at timestamptz;

update household_invites set code = generate_invite_code() where code is null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'household_invites_pkey' and conrelid = 'household_invites'::regclass
  ) then
    alter table household_invites drop constraint household_invites_pkey;
  end if;
end $$;

-- In 0003 email was the primary key and full_name/initials were required. All
-- three are optional now: email restricts an invite to one address, and the
-- name fields are prefill hints on a link anyone can accept. These run after
-- the primary key is gone — you cannot drop NOT NULL from a PK column.
alter table household_invites alter column email     drop not null;
alter table household_invites alter column full_name drop not null;
alter table household_invites alter column initials  drop not null;

-- Default it too, so a hand-written insert (or the 0003 backfill) still gets a
-- usable code instead of failing the not-null.
alter table household_invites alter column code set default generate_invite_code();
alter table household_invites alter column code set not null;
alter table household_invites add primary key (id);

create unique index if not exists household_invites_code_key on household_invites (code);
create index if not exists household_invites_email_idx on household_invites (lower(email));

/* ------------------------------------------------------- rotation membership */

-- Pending turns are re-derived from the current rotation. Completed turns are
-- history and are never touched — otherwise adding a roommate would rewrite
-- who did the dishes last Tuesday.
create or replace function resync_pending_turns(p_chore uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare touched int := 0;
begin
  with fixed as (
    update chore_turns t
       set assignee_id = rotation_assignee(t.chore_id, t.turn_number)
     where t.chore_id = p_chore
       and t.status = 'pending'
       and t.assignee_id is distinct from rotation_assignee(t.chore_id, t.turn_number)
    returning 1
  )
  select count(*) into touched from fixed;
  return touched;
end;
$$;

-- Appends someone to the end of every active rotation in the household.
create or replace function add_to_rotations(p_profile uuid, p_household uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare c record;
begin
  for c in select id from chores where household_id = p_household and is_active loop
    if not exists (
      select 1 from chore_rotation
      where chore_id = c.id and profile_id = p_profile
    ) then
      insert into chore_rotation (chore_id, profile_id, position)
      select c.id, p_profile,
             coalesce(max(position), -1) + 1
      from chore_rotation where chore_id = c.id;

      perform resync_pending_turns(c.id);
    end if;
  end loop;
end;
$$;

-- Removing someone must close the gap in `position`, or `turn % n` starts
-- pointing at a hole and assignments go null.
create or replace function remove_from_rotations(p_profile uuid, p_household uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare c record;
begin
  for c in select id from chores where household_id = p_household loop
    delete from chore_rotation where chore_id = c.id and profile_id = p_profile;

    with renumbered as (
      select profile_id, row_number() over (order by position) - 1 as new_position
      from chore_rotation where chore_id = c.id
    )
    update chore_rotation r
       set position = renumbered.new_position
      from renumbered
     where r.chore_id = c.id and r.profile_id = renumbered.profile_id;

    perform resync_pending_turns(c.id);
  end loop;
end;
$$;

/* --------------------------------------------------------- create household */

create or replace function create_household(
  p_name      text,
  p_address   text default null,
  p_timezone  text default 'America/Detroit',
  p_full_name text default null,
  p_initials  text default null
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

  -- A starter set. Every field is editable afterwards; the point is that a new
  -- household has something on the board instead of an empty screen.
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

  -- Fill the board so the first screen isn't empty.
  for chore_id in select id from chores where household_id = new_id loop
    if (select cadence from chores where id = chore_id) = 'scheduled' then
      perform materialize_schedule(chore_id);
    else
      perform top_up_queue(chore_id);
    end if;
  end loop;

  insert into activity_log (household_id, actor_id, verb, summary)
  values (new_id, me, 'created_household',
          (select full_name from profiles where id = me) || ' started the house');

  return new_id;
end;
$$;

/* ---------------------------------------------------------------- invites */

create or replace function create_invite(
  p_email      text default null,
  p_full_name  text default null,
  p_initials   text default null,
  p_color      text default '#64748b',
  p_expires_in interval default interval '14 days',
  p_max_uses   integer default 1
)
returns household_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  me   uuid := auth.uid();
  hh   uuid;
  row_out household_invites;
begin
  select household_id into hh from profiles where id = me;
  if hh is null then raise exception 'you are not in a household'; end if;
  if not is_household_admin() then raise exception 'only an admin can invite people'; end if;

  insert into household_invites (
    household_id, code, email, full_name, initials, color,
    created_by, expires_at, max_uses
  )
  values (
    hh, generate_invite_code(), nullif(lower(trim(coalesce(p_email, ''))), ''),
    nullif(trim(coalesce(p_full_name, '')), ''),
    nullif(upper(trim(coalesce(p_initials, ''))), ''),
    coalesce(p_color, '#64748b'),
    me,
    case when p_expires_in is null then null else now() + p_expires_in end,
    greatest(coalesce(p_max_uses, 1), 1)
  )
  returning * into row_out;

  return row_out;
end;
$$;

create or replace function revoke_invite(p_invite uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare hh uuid;
begin
  if not is_household_admin() then raise exception 'only an admin can revoke invites'; end if;
  select household_id into hh from profiles where id = auth.uid();

  update household_invites
     set revoked_at = now()
   where id = p_invite and household_id = hh and revoked_at is null;
end;
$$;

-- What a signed-in user sees before accepting, so the join screen can say
-- which house they are about to join without leaking anything else.
create or replace function peek_invite(p_code text)
returns table (household_name text, full_name text, initials text, valid boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  inv household_invites%rowtype;
  my_email text;
begin
  select * into inv from household_invites
   where upper(code) = upper(trim(p_code));

  if not found then
    return query select null::text, null::text, null::text, false, 'That code does not exist.';
    return;
  end if;

  select email into my_email from profiles where id = auth.uid();

  if inv.revoked_at is not null then
    return query select null::text, null::text, null::text, false, 'That invite was revoked.';
  elsif inv.expires_at is not null and inv.expires_at < now() then
    return query select null::text, null::text, null::text, false, 'That invite has expired.';
  elsif inv.used_count >= inv.max_uses then
    return query select null::text, null::text, null::text, false, 'That invite has already been used.';
  elsif inv.email is not null and lower(inv.email) is distinct from lower(coalesce(my_email, '')) then
    return query select null::text, null::text, null::text, false,
                        'That invite was issued to a different email address.';
  else
    return query
      select h.name, inv.full_name, inv.initials, true, null::text
      from households h where h.id = inv.household_id;
  end if;
end;
$$;

create or replace function redeem_invite(
  p_code      text,
  p_full_name text default null,
  p_initials  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me       uuid := auth.uid();
  inv      household_invites%rowtype;
  my_email text;
  existing uuid;
  resolved_name text;
begin
  if me is null then raise exception 'not signed in'; end if;

  select household_id, email into existing, my_email from profiles where id = me;
  if existing is not null then raise exception 'you are already in a household'; end if;

  -- Lock the row: two people redeeming a single-use code at the same moment
  -- must not both get in.
  select * into inv from household_invites
   where upper(code) = upper(trim(p_code))
   for update;

  if not found then raise exception 'That code does not exist.'; end if;
  if inv.revoked_at is not null then raise exception 'That invite was revoked.'; end if;
  if inv.expires_at is not null and inv.expires_at < now() then
    raise exception 'That invite has expired.';
  end if;
  if inv.used_count >= inv.max_uses then
    raise exception 'That invite has already been used.';
  end if;
  if inv.email is not null and lower(inv.email) is distinct from lower(coalesce(my_email, '')) then
    raise exception 'That invite was issued to a different email address.';
  end if;

  resolved_name := coalesce(
    nullif(trim(coalesce(p_full_name, '')), ''),
    inv.full_name,
    (select full_name from profiles where id = me)
  );

  update profiles
     set household_id = inv.household_id,
         full_name    = resolved_name,
         initials     = coalesce(
                          nullif(upper(trim(coalesce(p_initials, ''))), ''),
                          inv.initials,
                          upper(left(resolved_name, 2))
                        ),
         color        = coalesce(inv.color, color),
         is_admin     = coalesce(inv.is_admin, false)
   where id = me;

  update household_invites set used_count = used_count + 1 where id = inv.id;

  perform add_to_rotations(me, inv.household_id);

  insert into activity_log (household_id, actor_id, verb, summary)
  values (inv.household_id, me, 'joined_household', resolved_name || ' joined the house');

  return inv.household_id;
end;
$$;

-- Admins can remove someone; the rotation closes up behind them.
create or replace function remove_member(p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare hh uuid;
begin
  if not is_household_admin() then raise exception 'only an admin can remove someone'; end if;
  if p_profile = auth.uid() then raise exception 'you cannot remove yourself'; end if;

  select household_id into hh from profiles where id = auth.uid();
  if not exists (select 1 from profiles where id = p_profile and household_id = hh) then
    raise exception 'that person is not in your household';
  end if;

  perform remove_from_rotations(p_profile, hh);
  update profiles set household_id = null, is_admin = false where id = p_profile;
end;
$$;

create or replace function set_member_admin(p_profile uuid, p_is_admin boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare hh uuid;
begin
  if not is_household_admin() then raise exception 'only an admin can change roles'; end if;
  select household_id into hh from profiles where id = auth.uid();

  update profiles set is_admin = p_is_admin
   where id = p_profile and household_id = hh;

  if not exists (select 1 from profiles where household_id = hh and is_admin) then
    raise exception 'a household needs at least one admin';
  end if;
end;
$$;

/* ------------------------------------------------------------ kiosk devices */

alter table kiosk_devices
  add column if not exists created_by uuid references profiles(id) on delete set null;

-- Pairing code is shown once at creation; only its hash is stored.
create or replace function create_kiosk_device(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  hh   uuid;
  code text;
begin
  if not is_household_admin() then raise exception 'only an admin can pair a kiosk'; end if;
  select household_id into hh from profiles where id = auth.uid();
  if hh is null then raise exception 'you are not in a household'; end if;

  code := encode(gen_random_bytes(24), 'base64');
  code := replace(replace(replace(code, '+', '-'), '/', '_'), '=', '');

  insert into kiosk_devices (household_id, name, token_hash, created_by)
  values (hh, coalesce(nullif(trim(p_name), ''), 'Kiosk'),
          encode(digest(code, 'sha256'), 'hex'), auth.uid());

  return code;
end;
$$;

-- Called by the pairing route with the service role; resolves a raw token to
-- the household it belongs to. Constant-time-ish: we look up by hash, never
-- compare secrets in application code.
create or replace function resolve_kiosk_token(p_token text)
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
  returning household_id into hh;

  return hh;
end;
$$;

/* --------------------------------------------------------------------- RLS */

drop policy if exists inv_read on household_invites;
create policy inv_read on household_invites for select
  using (is_household_member(household_id));

drop policy if exists kiosk_read on kiosk_devices;
create policy kiosk_read on kiosk_devices for select
  using (is_household_member(household_id));

-- Membership and role changes go through the SECURITY DEFINER functions above.
-- Without this, `pr_write` lets anyone set their own household_id to another
-- household's uuid and read that entire house — harmless with one household,
-- a full data breach with two.
do $$
declare r text;
begin
  foreach r in array array['authenticated', 'domestic_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke update on profiles from %I', r);
      execute format(
        'grant update (full_name, initials, color, avatar_url, notify_push,
                       notify_email, quiet_from, quiet_to) on profiles to %I', r);
      execute format('grant execute on all functions in schema public to %I', r);
    end if;
  end loop;
end $$;
