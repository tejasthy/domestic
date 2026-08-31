-- Minimal stand-in for the pieces of Supabase's auth schema the migrations
-- touch, so the real migrations can run unmodified against stock Postgres.
create schema if not exists auth;

create table auth.users (
  id                   uuid primary key default gen_random_uuid(),
  email                text unique,
  raw_user_meta_data   jsonb not null default '{}'
);

-- Supabase derives this from the request JWT; here it reads a session GUC so
-- tests can impersonate a roommate with set_config('request.user_id', ...).
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.user_id', true), '')::uuid;
$$;
