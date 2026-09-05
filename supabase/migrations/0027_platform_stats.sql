-- Read-only, aggregate-only cross-household stats for the platform-admin
-- page (src/app/platform-admin) — derived from data that already exists
-- rather than a new telemetry pipeline. No raw per-user rows anywhere here
-- except platform_feedback, which is a deliberate, narrow exception: replying
-- to a bug report requires knowing who filed it.
--
-- Every function opens with an is_platform_admin() check — this is the real
-- authorization boundary (see 0025), not the Next.js route gate.

create or replace function platform_stats()
returns table (
  households_total            integer,
  households_last_30d         integer,
  members_total                integer,
  members_last_30d            integer,
  admins_total                 integer,
  module_enabled_counts        jsonb,
  turns_completed_last_7d      integer,
  turns_completed_last_30d     integer,
  turns_skipped_last_30d       integer,
  cross_complete_enabled_count integer,
  geofence_enabled_count       integer,
  signup_source_counts         jsonb,
  feedback_total                integer,
  feedback_last_30d            integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then raise exception 'not authorized'; end if;

  return query select
    (select count(*)::int from households),
    (select count(*)::int from households where created_at > now() - interval '30 days'),
    (select count(*)::int from profiles where household_id is not null),
    (select count(*)::int from profiles where household_id is not null and created_at > now() - interval '30 days'),
    (select count(*)::int from profiles where is_admin),
    (select coalesce(jsonb_object_agg(module, cnt), '{}'::jsonb)
       from (select module, count(*) cnt from household_modules where enabled group by module) s),
    (select count(*)::int from chore_turns where status = 'done' and completed_at > now() - interval '7 days'),
    (select count(*)::int from chore_turns where status = 'done' and completed_at > now() - interval '30 days'),
    (select count(*)::int from chore_turns where status = 'skipped' and completed_at > now() - interval '30 days'),
    (select count(*)::int from households where allow_member_cross_complete),
    (select count(*)::int from households where geofence_enabled),
    (select coalesce(jsonb_object_agg(coalesce(signup_source, '(direct)'), cnt), '{}'::jsonb)
       from (select signup_source, count(*) cnt from households group by signup_source) s),
    (select count(*)::int from feedback_submissions),
    (select count(*)::int from feedback_submissions where created_at > now() - interval '30 days');
end;
$$;

-- Deliberately excludes name/address/location/timezone — no product reason
-- for a platform operator to see per-resident identifying details in
-- aggregate, only the shape of how each household is configured.
create or replace function platform_households_summary(p_limit integer default 200)
returns table (
  id                           uuid,
  created_at                   timestamptz,
  member_count                 integer,
  modules_enabled              text[],
  allow_member_cross_complete  boolean,
  geofence_enabled             boolean,
  signup_source                text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then raise exception 'not authorized'; end if;

  return query
    select h.id, h.created_at,
           (select count(*)::int from profiles p where p.household_id = h.id),
           enabled_modules(h.id), h.allow_member_cross_complete, h.geofence_enabled, h.signup_source
    from households h
    order by h.created_at desc
    limit greatest(1, least(p_limit, 1000));
end;
$$;

create or replace function platform_feedback(p_limit integer default 100)
returns table (
  id             uuid,
  household_name text,
  submitter_name text,
  kind           text,
  body           text,
  metadata       jsonb,
  created_at     timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_platform_admin() then raise exception 'not authorized'; end if;

  return query
    select f.id, h.name, p.full_name, f.kind, f.body, f.metadata, f.created_at
    from feedback_submissions f
    left join households h on h.id = f.household_id
    left join profiles p on p.id = f.profile_id
    order by f.created_at desc
    limit greatest(1, least(p_limit, 500));
end;
$$;
