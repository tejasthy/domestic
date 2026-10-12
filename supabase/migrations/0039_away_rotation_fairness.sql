-- Out-of-town handling that keeps the rotation fair.
--
-- What production logs showed (Oct 2026, 4-person house, rotation T > A > B > N):
--   * Dishes #28-30 went Brandon, Brandon, Brandon and #31-32 Tejas, Tejas.
--     rotation_assignee handed an away person's turn to "the next person in
--     position order" -- who then *also* took their own turn, so one person ate
--     two or three in a row while everyone else got nothing.
--   * Trash when full #12 was still sitting with the cover (Aiden) although its
--     home owner's away date had lapsed days earlier. A date lapsing is not an
--     event, so nothing re-derived pending turns; only the explicit "I'm back"
--     button did.
--
-- What changes:
--   1. Rotation is derived by continuing from whoever had the PREVIOUS turn
--      (next available person after them), instead of from `turn % n`. With
--      nobody away this yields exactly the old turn % n order; while someone is
--      away the rotation simply rotates over the people who are present
--      (B, C, B, C), so there are no double-ups. Still derived from history in
--      chore_turns -- no mutable pointer to desync. Turns with no history
--      (hand-inserted / first turn) fall back to turn % n.
--   2. Make-up on return, only for SHORT trips: if the trip was shorter than one
--      full rotation of the people who stayed (1 <= turns during the trip <
--      people present) AND the returner was actually skipped on that chore, they
--      take the next turn. A trip covering a full rotation or more earns no
--      make-up -- they rejoin in order. (Skips are the chore_away_skips rows
--      from 0035; doing the chore wipes them, so a make-up is paid exactly once.)
--   3. Away dates that lapse on their own now trigger the same resync as "I'm
--      back" (sync_lapsed_away, called from the cron), and log "is back" once.
--
-- `create or replace` is safe here: no parameters are added to any function.

/* ----------------------------------------------- lapse bookkeeping */

alter table member_away add column if not exists lapse_handled_at timestamptz;

-- Any explicit early close (set_away replacing a window, clear_away,
-- admin_clear_away) already resyncs and logs for itself, so it must not also be
-- picked up by sync_lapsed_away. Rather than editing all three, mark the row
-- handled whenever ends_at is changed by an UPDATE.
create or replace function member_away_mark_closed()
returns trigger
language plpgsql
as $$
begin
  if new.ends_at is distinct from old.ends_at then
    new.lapse_handled_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists member_away_mark_closed on member_away;
create trigger member_away_mark_closed
  before update of ends_at on member_away
  for each row execute function member_away_mark_closed();

-- Windows that ended before this migration are history -- except the last few
-- days, which are left for the first sync_lapsed_away() run to repair (turns
-- still held by a cover after the owner's date lapsed). That run also logs one
-- "is back" line per such window; windows closed by hand in that period get
-- one too, which is harmless noise.
update member_away set lapse_handled_at = now()
 where ends_at is not null
   and ends_at <= now() - interval '3 days'
   and lapse_handled_at is null;

/* -------------------------------------------------------- make-up check */

-- Is `p_profile` owed a make-up turn on `p_chore` for turn `p_turn` judged at
-- `p_at`? Volatile on purpose: it reads chore_away_skips rows that
-- rotation_assignee may have written earlier in the same statement.
create or replace function away_makeup_owed(
  p_chore uuid, p_profile uuid, p_turn integer, p_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  w         record;
  k         int;
  m         int;
  last_turn int;
begin
  for w in
    select id, starts_at, ends_at from member_away
     where profile_id = p_profile
       and ends_at is not null
       and ends_at <= p_at
     order by ends_at desc
  loop
    -- only a window in which they were really skipped on this chore
    if not exists (
      select 1 from chore_away_skips
       where chore_id = p_chore and profile_id = p_profile and away_id = w.id
    ) then
      continue;
    end if;

    -- turns of this chore that fell inside the window
    select count(*), max(turn_number) into k, last_turn
      from chore_turns
     where chore_id = p_chore
       and turn_number < p_turn
       and coalesce(due_at, completed_at, created_at) >= w.starts_at
       and coalesce(due_at, completed_at, created_at) <  w.ends_at;

    -- people who stayed (everyone else who was present when the trip began)
    select count(*) into m
      from chore_rotation cr
     where cr.chore_id = p_chore
       and cr.profile_id <> p_profile
       and not is_away_at(cr.profile_id, w.starts_at);

    -- a full rotation or more of the people who stayed => no make-up
    if k < 1 or k >= m then
      continue;
    end if;

    -- already repaid: they have been given a turn since the window's last one
    if exists (
      select 1 from chore_turns
       where chore_id = p_chore
         and assignee_id = p_profile
         and turn_number > last_turn
         and turn_number < p_turn
    ) then
      continue;
    end if;

    return true;
  end loop;

  return false;
end;
$$;

/* ------------------------------------------------------------ rotation */

create or replace function rotation_assignee(p_chore uuid, p_turn integer, p_at timestamptz default now())
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  n           int;
  base        int;
  prev_pos    int;
  cand        uuid;
  overridden  boolean;
  cur_away_id uuid;
  r           record;
begin
  select count(*) into n from chore_rotation where chore_rotation.chore_id = p_chore;
  if n = 0 then
    return null;
  end if;

  -- A returner owed a make-up goes first, if they are present for this turn.
  for r in
    select profile_id, away_override from chore_rotation
     where chore_id = p_chore order by position
  loop
    if (r.away_override or not is_away_at(r.profile_id, p_at))
       and away_makeup_owed(p_chore, r.profile_id, p_turn, p_at) then
      return r.profile_id;
    end if;
  end loop;

  -- Continue from whoever had the previous turn. With nobody ever away this is
  -- identical to the old `turn % n`; with someone away it rotates over those
  -- present instead of doubling up the person after them. Real turns are
  -- contiguous (append_turn is max + 1); across a gap there is no reliable
  -- history, so fall back to turn % n.
  select cr.position into prev_pos
    from chore_turns t
    join chore_rotation cr on cr.chore_id = t.chore_id and cr.profile_id = t.assignee_id
   where t.chore_id = p_chore and t.turn_number = p_turn - 1;

  base := case when prev_pos is null then p_turn % n else (prev_pos + 1) % n end;

  for i in 0..n - 1 loop
    select profile_id, away_override into cand, overridden
    from chore_rotation
    where chore_rotation.chore_id = p_chore
      and chore_rotation.position = (base + i) % n;

    if overridden or not is_away_at(cand, p_at) then
      return cand;
    end if;

    select id into cur_away_id from member_away
     where profile_id = cand and starts_at <= p_at and (ends_at is null or p_at < ends_at)
     order by starts_at desc limit 1;

    if cur_away_id is not null then
      insert into chore_away_skips (chore_id, profile_id, away_id)
      values (p_chore, cand, cur_away_id)
      on conflict (chore_id, profile_id, away_id) do nothing;
    end if;
  end loop;

  -- Everyone in the rotation is away at p_at: pause, don't assign anyone.
  return null;
end;
$$;

-- Ascending order matters now: each pending turn is derived from the one
-- before it, so earlier turns must already hold their new assignee. Otherwise
-- identical to 0020 (a turn nobody can take is still auto-skipped).
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
    select * from chore_turns
     where chore_id = p_chore and status = 'pending'
     order by turn_number
       for update
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

/* ------------------------------------------------------ lapsed windows */

-- An away date that simply passes is not an event, so turns held by a cover
-- stayed with them. Called from the cron: re-derive the household's pending
-- turns once per lapsed window and log "is back" exactly once.
create or replace function sync_lapsed_away()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  w       record;
  c       record;
  handled int := 0;
  done_hh uuid[] := '{}';
begin
  for w in
    select a.id, a.household_id, p.full_name
      from member_away a
      join profiles p on p.id = a.profile_id
     where a.ends_at is not null
       and a.ends_at <= now()
       and a.lapse_handled_at is null
     order by a.ends_at
       for update of a
  loop
    update member_away set lapse_handled_at = now() where id = w.id;

    if not (w.household_id = any (done_hh)) then
      done_hh := done_hh || w.household_id;
      for c in select id, cadence from chores where household_id = w.household_id and is_active loop
        perform resync_pending_turns(c.id);
        if c.cadence <> 'scheduled' then
          perform top_up_queue(c.id);
        end if;
      end loop;
    end if;

    insert into activity_log (household_id, actor_id, verb, summary, metadata)
    values (w.household_id, null, 'cleared_away', w.full_name || ' is back',
            jsonb_build_object('lapsed', true));

    handled := handled + 1;
  end loop;

  return handled;
end;
$$;

-- Cron only (service_role). Same lockdown as the kiosk RPCs in 0012/0015.
do $$
declare r text;
begin
  foreach r in array array['authenticated', 'domestic_app', 'anon'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function sync_lapsed_away() from %I', r);
    end if;
  end loop;
end $$;

revoke execute on function sync_lapsed_away() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function sync_lapsed_away() to service_role;
  end if;
end $$;
