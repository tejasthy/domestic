-- A lightweight in-app way to report a bug or request a feature. No RLS
-- policy at all — same pattern as household_ai_config (0011): every access
-- goes through a security-definer function (submit_feedback here to write,
-- platform_feedback in 0027 to read), so nobody, including a household's own
-- admin, can query this table directly.

create table if not exists feedback_submissions (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid references households(id) on delete set null,
  profile_id   uuid references profiles(id) on delete set null,
  kind         text not null check (kind in ('bug', 'feature')),
  body         text not null check (char_length(trim(body)) between 1 and 4000),
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now()
);

alter table feedback_submissions enable row level security;

-- household_id/profile_id are stamped from auth.uid() server-side, never
-- trusted from the client, so nobody can spoof a submission as coming from
-- another household. household_id is nullable so someone hitting a bug
-- before finishing onboarding can still report it.
create or replace function submit_feedback(p_kind text, p_body text, p_metadata jsonb default '{}')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  hh     uuid;
  new_id uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_kind not in ('bug', 'feature') then raise exception 'unknown feedback kind'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'say a little about what happened'; end if;

  select household_id into hh from profiles where id = me;

  insert into feedback_submissions (household_id, profile_id, kind, body, metadata)
  values (hh, me, p_kind, trim(p_body), coalesce(p_metadata, '{}'::jsonb))
  returning id into new_id;

  return new_id;
end;
$$;
