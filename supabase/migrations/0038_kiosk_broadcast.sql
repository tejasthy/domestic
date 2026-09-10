-- The kiosk polled router.refresh() every 5s, 24/7 — that alone was ~8.8k
-- server renders/day for one display and dominated Vercel's Fluid Active CPU
-- usage. Replace it with a push: broadcast a "something changed" signal to
-- the kiosk's own browser the moment a relevant row is written, and fall back
-- to a much slower poll client-side for time-based transitions (e.g. a turn
-- crossing from "today" into "overdue" at midnight) and as a self-heal if a
-- broadcast is ever missed.
--
-- This can't be a normal RLS-scoped Realtime subscription — the kiosk has no
-- Supabase auth session at all (see loadKiosk in src/lib/kiosk.ts, which
-- reads with the service role and filters by household_id by hand). So this
-- uses Realtime's public "broadcast from database" (realtime.send), with the
-- channel topic set to the device's own token_hash. That hash is already the
-- one secret gating this device everywhere else (resolve_device_token), so
-- reusing it as the channel name needs no new secret and the broadcast
-- payload itself carries no row data — worst case a topic leak reveals only
-- "something changed for this device at time T", nothing about what.

create or replace function notify_kiosk_devices(p_household_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare d record;
begin
  for d in
    select token_hash from kiosk_devices
    where household_id = p_household_id and kind = 'kiosk'
  loop
    perform realtime.send(
      jsonb_build_object('at', now()),
      'kiosk-refresh',
      d.token_hash,
      false
    );
  end loop;
end;
$$;

-- activity_log is the household's unified event log — every turn completed,
-- skipped, flagged, undone; every expense, settlement, swap, geofence and
-- standing-chore action — already writes a row here as part of the same
-- atomic transaction, which makes it the one hook that covers nearly
-- everything the kiosk displays.
create or replace function notify_kiosk_on_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform notify_kiosk_devices(new.household_id);
  return null;
end;
$$;

drop trigger if exists kiosk_notify_activity_log on activity_log;
create trigger kiosk_notify_activity_log
  after insert on activity_log
  for each row execute function notify_kiosk_on_activity();

-- Kiosk notes (posted by an admin, dismissed from the wall) never write to
-- activity_log — they're the record themselves.
create or replace function notify_kiosk_on_message_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform notify_kiosk_devices(coalesce(new.household_id, old.household_id));
  return null;
end;
$$;

drop trigger if exists kiosk_notify_kiosk_messages on kiosk_messages;
create trigger kiosk_notify_kiosk_messages
  after insert or delete on kiosk_messages
  for each row execute function notify_kiosk_on_message_change();

-- kiosk_set_chore_active is the one other kiosk-visible write that skips
-- activity_log (a chore going active/inactive, plus whatever turn its
-- materialize_schedule/top_up_queue call produces) — same body as
-- 0012_kiosk_interactivity.sql with a notify appended.
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

  perform notify_kiosk_devices(p_household);
end;
$$;
