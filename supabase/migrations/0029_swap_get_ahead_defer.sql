-- Second course-correction: get_ahead/defer_turn (0023) completed a turn
-- early / pushed a due date. The actual ask is a queue-position swap that
-- never completes anything: get_ahead trades your own upcoming turn for
-- whoever currently holds the chore (you take their current turn, they take
-- your future one); defer is the mirror — you hand your current turn to the
-- next person in line and take their future one instead. Neither one is
-- reachable twice in a row on the same chore without something else
-- happening in between: once you hold the current turn, get_ahead's own
-- "it's already your turn" guard blocks a repeat, which is what makes the
-- old "how many turns ahead" cap unnecessary — a plain rolling-30-day use
-- count per direction is enough.
--
-- Same signatures as 0023 (get_ahead(uuid), defer_turn(uuid)), so this is a
-- plain create-or-replace, no drop needed.

/* -------------------------------------------------------------- helpers */

-- Finds profile p_profile's next turn on this chore beyond p_after_turn_number
-- — an already-pending one if it exists, otherwise walks forward
-- (materializing as it goes, same mechanism append_turn/materialize_schedule
-- already use) until it reaches one. Shared by both directions below: for
-- get_ahead the "someone else" is whoever currently holds the chore; for
-- defer it's the next person in the rotation.
create or replace function find_or_create_next_turn_for(
  p_chore uuid, p_profile uuid, p_after_turn_number integer
)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  c          chores%rowtype;
  target     chore_turns%rowtype;
  tz         text;
  next_due   date;
  last_due   date;
  iterations int := 0;
  cap        constant int := 500;
begin
  select * into c from chores where id = p_chore;

  select * into target from chore_turns
   where chore_id = p_chore and status = 'pending' and assignee_id = p_profile
     and turn_number > p_after_turn_number
   order by turn_number limit 1;
  if found then
    return target;
  end if;

  if c.cadence = 'scheduled' then
    select timezone into tz from households where id = c.household_id;
    select coalesce(max((due_at at time zone tz)::date), c.anchor_date - 1) into last_due
      from chore_turns where chore_id = p_chore;
    loop
      iterations := iterations + 1;
      exit when iterations > cap;
      next_due := next_scheduled_date(p_chore, last_due);
      exit when next_due is null;
      target := append_turn(p_chore, (next_due + make_interval(hours => c.due_hour)) at time zone tz);
      last_due := next_due;
      exit when target.id is not null and target.assignee_id = p_profile;
    end loop;
  else
    loop
      iterations := iterations + 1;
      exit when iterations > cap;
      target := append_turn(p_chore, null);
      exit when target.id is null;
      exit when target.assignee_id = p_profile;
    end loop;
  end if;

  if target.id is null or target.assignee_id is distinct from p_profile then
    raise exception 'could not find an upcoming turn for that person';
  end if;

  return target;
end;
$$;

/* ------------------------------------------------------------- get_ahead */

create or replace function get_ahead(p_chore uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  me             uuid := auth.uid();
  c              chores%rowtype;
  current_turn   chore_turns%rowtype;
  my_turn        chore_turns%rowtype;
  current_holder uuid;
  mod_enabled    boolean;
  mod_settings   jsonb;
  max_per_30d    int;
  uses_30d       int;
begin
  select * into c from chores where id = p_chore;
  if not found then raise exception 'chore not found'; end if;
  if not is_household_member(c.household_id) then raise exception 'not your household'; end if;
  if c.cadence = 'standing' then
    raise exception 'get-ahead does not apply to standing chores — pass it on if you cannot get to it';
  end if;
  if not exists (select 1 from chore_rotation where chore_id = p_chore and profile_id = me) then
    raise exception 'you are not in this chore''s rotation';
  end if;

  select enabled, settings into mod_enabled, mod_settings
    from household_modules where household_id = c.household_id and module = 'get_ahead';
  if not coalesce(mod_enabled, true) then raise exception 'get-ahead is turned off for this house'; end if;
  max_per_30d := coalesce((coalesce(mod_settings, '{}'::jsonb) #>> '{get_ahead,max_per_30d}')::int, 1);

  select * into current_turn from chore_turns
   where chore_id = p_chore and status = 'pending'
   order by turn_number limit 1;
  if not found then raise exception 'nothing pending on this chore'; end if;

  current_holder := current_turn.assignee_id;
  if current_holder = me then
    raise exception 'it is already your turn';
  end if;

  select count(*) into uses_30d from chore_advance_log
   where chore_id = p_chore and profile_id = me and kind = 'get_ahead'
     and created_at > now() - interval '30 days';
  if uses_30d >= max_per_30d then
    raise exception 'You have used get-ahead % time(s) in the last 30 days — the house limit is %.', uses_30d, max_per_30d;
  end if;

  my_turn := find_or_create_next_turn_for(p_chore, me, current_turn.turn_number);

  update chore_turns set assignee_id = me where id = current_turn.id;
  update chore_turns set assignee_id = current_holder where id = my_turn.id;

  insert into chore_advance_log (chore_id, profile_id, kind, turn_id)
  values (p_chore, me, 'get_ahead', current_turn.id);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select c.household_id, me, 'got_ahead', p.full_name || ' got ahead on ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', current_turn.id, 'emoji', c.emoji)
  from profiles p where p.id = me;

  select * into current_turn from chore_turns where id = current_turn.id;
  return current_turn;
end;
$$;

/* --------------------------------------------------------------- defer */

create or replace function defer_turn(p_turn uuid)
returns chore_turns
language plpgsql
security definer
set search_path = public
as $$
declare
  me          uuid := auth.uid();
  t           chore_turns%rowtype;
  c           chores%rowtype;
  next_person uuid;
  other_turn  chore_turns%rowtype;
  n           int;
  cur_pos     int;
  cand        uuid;
  mod_enabled boolean;
  mod_settings jsonb;
  max_per_30d int;
  uses_30d    int;
begin
  select * into t from chore_turns where id = p_turn for update;
  if not found then raise exception 'turn not found'; end if;
  if not is_household_member(t.household_id) then raise exception 'not your household'; end if;
  if t.status <> 'pending' then raise exception 'that turn is not pending'; end if;
  if me is distinct from t.assignee_id then raise exception 'you can only defer your own turn'; end if;

  select * into c from chores where id = t.chore_id;
  if c.cadence = 'standing' then
    raise exception 'defer does not apply to standing chores — pass it to the next person instead';
  end if;

  select enabled, settings into mod_enabled, mod_settings
    from household_modules where household_id = c.household_id and module = 'get_ahead';
  if not coalesce(mod_enabled, true) then raise exception 'get-ahead/defer is turned off for this house'; end if;
  max_per_30d := coalesce((coalesce(mod_settings, '{}'::jsonb) #>> '{defer,max_per_30d}')::int, 1);

  select count(*) into uses_30d from chore_advance_log
   where chore_id = t.chore_id and profile_id = me and kind = 'defer'
     and created_at > now() - interval '30 days';
  if uses_30d >= max_per_30d then
    raise exception 'You have deferred % time(s) in the last 30 days — the house limit is %.', uses_30d, max_per_30d;
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
  values (t.chore_id, me, 'defer', t.id);

  insert into activity_log (household_id, actor_id, verb, summary, metadata)
  select t.household_id, me, 'deferred_chore', p.full_name || ' pushed back ' || c.name,
         jsonb_build_object('chore_id', c.id, 'turn_id', t.id, 'emoji', c.emoji)
  from profiles p where p.id = me;

  select * into t from chore_turns where id = t.id;
  return t;
end;
$$;
