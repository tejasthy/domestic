-- update_chore (0033) treated ANY cadence-affecting change the same way:
-- delete every pending turn, then rebuild from scratch. That is right when
-- crossing into or out of `scheduled` (a due-date pattern means something
-- different under the new rule, so nothing is worth keeping turn-by-turn),
-- but wrong for on_demand <-> standing — 0021 already documented standing as
-- "on_demand's queue model with queue_depth pinned to 1", so switching
-- between them, or resizing an on_demand queue, should keep whoever is
-- already queued (and any flag/due-date already stamped on the current
-- turn) instead of bumping everyone back to the front of the rotation.

create or replace function update_chore(
  p_chore           uuid,
  p_name            text default null,
  p_emoji           text default null,
  p_description     text default null,
  p_cadence         chore_cadence default null,
  p_days_of_week    smallint[] default null,
  p_interval_weeks  smallint default null,
  p_due_hour        smallint default null,
  p_queue_depth     smallint default null,
  p_lookahead_days  smallint default null,
  p_sort_order      smallint default null,
  p_allow_get_ahead boolean default null,
  p_allow_defer     boolean default null
)
returns chores
language plpgsql
security definer
set search_path = public
as $$
declare
  hh                uuid;
  before            chores%rowtype;
  after             chores%rowtype;
  schedule_relevant boolean;
  queue_relevant    boolean;
begin
  if not is_household_admin() then raise exception 'only an admin can edit a chore'; end if;
  select household_id into hh from profiles where id = auth.uid();

  select * into before from chores where id = p_chore and household_id = hh;
  if not found then raise exception 'that chore is not in your household'; end if;

  update chores set
    name             = coalesce(nullif(trim(p_name), ''), name),
    emoji            = coalesce(nullif(trim(p_emoji), ''), emoji),
    description      = case when p_description is not null
                            then nullif(trim(p_description), '') else description end,
    cadence          = coalesce(p_cadence, cadence),
    days_of_week     = coalesce(p_days_of_week, days_of_week),
    interval_weeks   = coalesce(p_interval_weeks, interval_weeks),
    due_hour         = coalesce(p_due_hour, due_hour),
    queue_depth      = coalesce(p_queue_depth, queue_depth),
    lookahead_days   = coalesce(p_lookahead_days, lookahead_days),
    sort_order       = coalesce(p_sort_order, sort_order),
    allow_get_ahead  = coalesce(p_allow_get_ahead, allow_get_ahead),
    allow_defer      = coalesce(p_allow_defer, allow_defer)
  where id = p_chore
  returning * into after;

  schedule_relevant := after.cadence = 'scheduled' or before.cadence = 'scheduled';
  queue_relevant :=
    not schedule_relevant and (
      after.cadence     is distinct from before.cadence or
      after.queue_depth is distinct from before.queue_depth
    );

  if schedule_relevant then
    if after.cadence        is distinct from before.cadence or
       after.days_of_week   is distinct from before.days_of_week or
       after.interval_weeks is distinct from before.interval_weeks or
       after.due_hour       is distinct from before.due_hour
    then
      delete from chore_turns where chore_id = p_chore and status = 'pending';
      if after.cadence = 'scheduled' then
        perform materialize_schedule(p_chore);
      else
        perform top_up_queue(p_chore);
      end if;
    end if;
  elsif queue_relevant then
    if after.cadence = 'standing' then
      -- Keep only the earliest (current) pending turn — same one whoever
      -- holds it was already assigned, flagged, or due on.
      delete from chore_turns t
       where t.chore_id = p_chore and t.status = 'pending'
         and t.turn_number <> (
           select min(turn_number) from chore_turns
            where chore_id = p_chore and status = 'pending'
         );
    elsif after.queue_depth < before.queue_depth then
      -- Shrinking an on-demand queue: drop the furthest-out turns, keep the
      -- ones closest to being up (including whichever is already flagged).
      delete from chore_turns t
       where t.chore_id = p_chore and t.status = 'pending'
         and t.turn_number not in (
           select turn_number from chore_turns
            where chore_id = p_chore and status = 'pending'
            order by turn_number asc
            limit after.queue_depth
         );
    end if;
    perform top_up_queue(p_chore);
  end if;

  return after;
end;
$$;

-- ------------------------------------------------------------- data repair
-- Any chore already switched to `standing` under the old logic may be
-- sitting with more pending turns than the model allows (top_up_queue only
-- ever topped up the count; it never trims). Collapse each back to its
-- single earliest turn, same rule as above.
delete from chore_turns t
 where t.status = 'pending'
   and t.chore_id in (select id from chores where cadence = 'standing')
   and t.turn_number <> (
     select min(turn_number) from chore_turns t2
      where t2.chore_id = t.chore_id and t2.status = 'pending'
   );
