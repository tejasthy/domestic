-- defer_turn can cascade indefinitely: A defers to B, B defers to C, ... and
-- once it wraps back around to someone who already holds a queued turn (from
-- an earlier defer in the same chain), it just swaps into that turn instead
-- of erroring — confirmed by walking a 4-person rotation through the full
-- cascade by hand. Nothing stopped a turn from being handed off forever.
--
-- Fix: cap how many times a single turn can be deferred, full stop, whoever
-- is doing the deferring. chore_advance_log's turn_id is the *turn being
-- deferred* (p_turn), and that row's own id never changes as it gets
-- reassigned around the rotation — only assignee_id does — so counting kind
-- = 'defer' rows for that turn_id is exactly "how many times has this one
-- turn cascaded," independent of who each individual deferrer was. Once a
-- turn hits the cap, whoever holds it has to actually do it, pass it to a
-- specific person, or skip it — defer_turn stops being an option for it.
--
-- Configured the same way as the existing max_per_30d caps: household_modules
-- settings under the 'get_ahead' module, key defer.max_chain. Defaults to the
-- household's own member count — a turn can cascade through everyone at most
-- once before it must be completed, passed to someone specific, or skipped —
-- rather than a flat number that means something different in a 2-person
-- house than a 6-person one. Still admin-overridable to any explicit number.

create or replace function defer_turn(p_turn uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  me           uuid := auth.uid();
  t            chore_turns%rowtype;
  c            chores%rowtype;
  next_person  uuid;
  other_turn   chore_turns%rowtype;
  n            int;
  cur_pos      int;
  cand         uuid;
  mod_enabled  boolean;
  mod_settings jsonb;
  max_per_30d  int;
  uses_30d     int;
  max_chain    int;
  chain_count  int;
  hh_size      int;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then raise exception 'turn not found'; end if;
  if not is_household_member(t.household_id) then raise exception 'not your household'; end if;
  if t.status <> 'pending' then raise exception 'that turn is not pending'; end if;
  if me is distinct from t.assignee_id then raise exception 'you can only defer your own turn'; end if;

  select * into c from chores where id = t.chore_id;
  if not c.allow_defer then
    raise exception 'defer is turned off for this chore';
  end if;

  select enabled, settings into mod_enabled, mod_settings
    from household_modules where household_id = c.household_id and module = 'get_ahead';
  if not coalesce(mod_enabled, true) then raise exception 'get-ahead/defer is turned off for this house'; end if;
  max_per_30d := coalesce((coalesce(mod_settings, '{}'::jsonb) #>> '{defer,max_per_30d}')::int, 1);

  select count(*) into hh_size from profiles where household_id = c.household_id;
  max_chain := coalesce((coalesce(mod_settings, '{}'::jsonb) #>> '{defer,max_chain}')::int, hh_size);

  select count(*) into uses_30d from chore_advance_log
   where chore_id = t.chore_id and profile_id = me and kind = 'defer'
     and created_at > now() - interval '30 days';
  if uses_30d >= max_per_30d then
    raise exception 'You have deferred % time(s) in the last 30 days — the house limit is %.', uses_30d, max_per_30d;
  end if;

  select count(*) into chain_count from chore_advance_log
   where turn_id = p_turn and kind = 'defer';
  if chain_count >= max_chain then
    raise exception 'This turn has already been deferred % time(s) — the house limit is %. Pass it to someone specific or skip it instead.', chain_count, max_chain;
  end if;

  select count(*) into n from chore_rotation where chore_id = t.chore_id;
  if n <= 1 then raise exception 'no one else in the rotation to defer to'; end if;

  select position into cur_pos from chore_rotation where chore_id = t.chore_id and profile_id = me;
  if cur_pos is null then raise exception 'you are not in this chore''s rotation'; end if;

  next_person := null;
  for i in 1..n - 1 loop
    select profile_id into cand from chore_rotation
     where chore_id = t.chore_id and position = (cur_pos + i) % n;
    if not is_away_at(cand, coalesce(t.due_at, now())) then
      next_person := cand;
      exit;
    end if;
  end loop;

  if next_person is null then
    raise exception 'everyone else is away — pass or skip instead';
  end if;

  other_turn := find_or_create_next_turn_for(t.chore_id, next_person, t.turn_number);

  update chore_turns set assignee_id = next_person where id = t.id;
  update chore_turns set assignee_id = me where id = other_turn.id;

  insert into chore_advance_log (chore_id, profile_id, kind, turn_id)
  values (t.chore_id, me, 'defer', p_turn);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me, 'deferred_chore', p.full_name || ' pushed back ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = me;

  select * into t from chore_turns where id = t.id;
  return t;
end;
$$;
