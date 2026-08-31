/* ------------------------------------------------------- kiosk undo turn */

-- Undo, but for the kiosk's device-token + "acting as" model instead of
-- auth.uid() -- same household+profile validation as the other kiosk_* RPCs
-- (0012) and the same rotation-safety guarantee as undo_turn (0018):
-- turn_number is immutable, so reopening a turn can't desync anyone's
-- position in the cycle. Unlike undo_turn, there is no assignee/cross-complete
-- gate here -- the kiosk's "acting as" model is already coarser than the
-- app's, same reasoning as kiosk_complete_turn.
create or replace function kiosk_undo_turn(
  p_household uuid,
  p_turn      uuid,
  p_profile   uuid
)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  t         chore_turns%rowtype;
  c         chores%rowtype;
  verb_word text;
begin
  if not exists (select 1 from profiles where id = p_profile and household_id = p_household) then
    raise exception 'not a member of this household';
  end if;

  select * into t from chore_turns where id = p_turn and household_id = p_household for update;
  if not found then raise exception 'turn not found'; end if;
  if t.status not in ('done', 'skipped') then
    raise exception 'that turn is not done or skipped';
  end if;

  verb_word := case when t.status = 'skipped' then 'skip' else 'done' end;

  update chore_turns
     set status = 'pending', completed_at = null, completed_by = null, note = null
   where id = p_turn
  returning * into t;

  select * into c from chores where id = t.chore_id;

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, p_profile, 'undid_chore',
         p.full_name || ' undid ' || verb_word || ' on ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = p_profile;

  return t;
end;
$$;

-- p_profile is explicit rather than auth.uid(), so lock to service_role --
-- same pattern as the other kiosk_* RPCs (0012, 0015, 0016).
do $$
declare r text;
begin
  foreach r in array array['authenticated', 'domestic_app', 'anon'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function kiosk_undo_turn(uuid, uuid, uuid) from %I', r);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function kiosk_undo_turn(uuid, uuid, uuid) to service_role;
  end if;
end $$;

revoke execute on function kiosk_undo_turn(uuid, uuid, uuid) from public;
