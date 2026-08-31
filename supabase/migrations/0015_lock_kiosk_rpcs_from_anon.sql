-- Fixes a real hole in 0012: the kiosk_* functions take an explicit
-- p_profile instead of reading auth.uid(), so they were meant to be callable
-- only by service_role. 0012's lockdown only revoked EXECUTE from
-- 'authenticated'/'domestic_app' (mirroring 0004's precedent) plus the
-- implicit PUBLIC grant — but Supabase also grants 'anon' its own separate
-- default-privilege EXECUTE grant on new functions, the same way it does for
-- 'authenticated'. That grant was never revoked, so an unauthenticated caller
-- (just the anon/public API key — not a secret) could call
-- kiosk_complete_turn / kiosk_flag_chore / kiosk_respond_swap /
-- kiosk_set_chore_active directly with a guessed household/turn/profile id,
-- completely bypassing auth. Revoke from 'anon' too.

do $$
declare r text;
begin
  foreach r in array array['authenticated', 'domestic_app', 'anon'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function kiosk_complete_turn(uuid, uuid, uuid, text) from %I', r);
      execute format('revoke execute on function kiosk_flag_chore(uuid, uuid, uuid) from %I', r);
      execute format('revoke execute on function kiosk_respond_swap(uuid, uuid, uuid, boolean) from %I', r);
      execute format('revoke execute on function kiosk_set_chore_active(uuid, uuid, uuid, boolean) from %I', r);
    end if;
  end loop;
end $$;

revoke execute on function kiosk_complete_turn(uuid, uuid, uuid, text) from public;
revoke execute on function kiosk_flag_chore(uuid, uuid, uuid) from public;
revoke execute on function kiosk_respond_swap(uuid, uuid, uuid, boolean) from public;
revoke execute on function kiosk_set_chore_active(uuid, uuid, uuid, boolean) from public;
