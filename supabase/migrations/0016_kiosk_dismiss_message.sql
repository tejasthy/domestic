/* ------------------------------------------------- kiosk message dismissal */

-- Lets an admin clear a note straight from the wall display, same admin gate
-- as kiosk_set_chore_active / kiosk_respond_swap, before it naturally expires.
create or replace function kiosk_dismiss_message(
  p_household uuid,
  p_message   uuid,
  p_profile   uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from profiles
    where id = p_profile and household_id = p_household and is_admin
  ) then
    raise exception 'only an admin can do that';
  end if;

  delete from kiosk_messages
   where id = p_message and household_id = p_household;
  if not found then raise exception 'message not found'; end if;
end;
$$;

-- p_profile is explicit rather than auth.uid(), so this must only ever run as
-- service_role — same lockdown as the other kiosk_* RPCs (see 0012, 0015).
do $$
declare r text;
begin
  foreach r in array array['authenticated', 'domestic_app', 'anon'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function kiosk_dismiss_message(uuid, uuid, uuid) from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function kiosk_dismiss_message(uuid, uuid, uuid) to service_role;
  end if;
end $$;

revoke execute on function kiosk_dismiss_message(uuid, uuid, uuid) from public;
