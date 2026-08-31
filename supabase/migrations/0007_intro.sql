-- Tracks whether someone has seen the "how this works" walkthrough. On the
-- profile rather than localStorage so it follows them across devices — you
-- should not get the tour again just because you opened it on the iPad.

alter table profiles
  add column if not exists intro_seen_at timestamptz;

-- 0004 revoked blanket UPDATE on profiles and re-granted it column by column,
-- so a new user-writable column has to be added to that grant explicitly.
do $$
declare r text;
begin
  foreach r in array array['authenticated', 'domestic_app'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant update (intro_seen_at) on profiles to %I', r);
    end if;
  end loop;
end $$;
