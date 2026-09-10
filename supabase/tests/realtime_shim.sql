-- Minimal stand-in for the piece of Supabase's Realtime extension the kiosk
-- broadcast migration touches, so the real migrations can run unmodified
-- against stock Postgres. The real realtime.send fans a message out over
-- websockets; here it is a no-op with the same signature, since these tests
-- only care that the triggers fire without error.
create schema if not exists realtime;

create or replace function realtime.send(
  payload  jsonb,
  event    text,
  topic    text,
  private  boolean default true
) returns void
language plpgsql as $$
begin
end;
$$;
