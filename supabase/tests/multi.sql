\set ON_ERROR_STOP on

-- ============================================================ self-serve setup
-- A brand new signup with no invite creates their own household.

insert into auth.users (id, email, raw_user_meta_data)
values ('99999999-0000-0000-0000-000000000001','founder@newhouse.com','{"name":"Fiona Founder"}');

select set_config('request.user_id', '99999999-0000-0000-0000-000000000001', false);
select create_household('12 Elm St.', '12 Elm St., Ann Arbor, MI', 'America/Detroit', 'Fiona Founder', 'FF');

do $$
declare hh uuid;
begin
  select household_id into hh from profiles where id='99999999-0000-0000-0000-000000000001';
  if hh is null then raise exception 'FAIL: create_household did not attach the creator'; end if;
  if not (select is_admin from profiles where id='99999999-0000-0000-0000-000000000001') then
    raise exception 'FAIL: the creator should be an admin';
  end if;
  if (select count(*) from chores where household_id=hh) <> 5 then
    raise exception 'FAIL: expected 5 starter chores, got %',
      (select count(*) from chores where household_id=hh);
  end if;
  if (select count(*) from chore_turns where household_id=hh and status='pending') = 0 then
    raise exception 'FAIL: a new household should have turns on the board';
  end if;
  -- solo household: every turn belongs to the founder
  if exists (select 1 from chore_turns where household_id=hh
             and assignee_id <> '99999999-0000-0000-0000-000000000001') then
    raise exception 'FAIL: solo rotation assigned someone else';
  end if;
end $$;
\echo '  ok  create_household seeds chores, board, and an admin'

do $$
begin
  begin
    perform create_household('Second House');
    raise exception 'FAIL: was allowed to create a second household while in one';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  you cannot create a household while already in one'

-- ==================================================================== invites
select create_invite(null, 'Ravi Roommate', 'RR', '#D86018', interval '14 days', 1);

do $$
declare c text; ok boolean;
begin
  select code into c from household_invites where full_name='Ravi Roommate';
  if c !~ '^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$' then
    raise exception 'FAIL: invite code % is not in the readable format', c;
  end if;

  -- peek runs as the *inviter* here, which is fine — it only reveals the name.
  select valid into ok from peek_invite(c);
  if not ok then raise exception 'FAIL: a fresh invite should peek as valid'; end if;
end $$;
\echo '  ok  create_invite issues a readable, valid code'

-- Someone new redeems it.
insert into auth.users (id, email, raw_user_meta_data)
values ('99999999-0000-0000-0000-000000000002','ravi@newhouse.com','{"name":"Ravi R"}');

do $$
declare c text; hh uuid;
begin
  select code into c from household_invites where full_name='Ravi Roommate';
  perform set_config('request.user_id', '99999999-0000-0000-0000-000000000002', false);
  hh := redeem_invite(c);

  if (select household_id from profiles where id='99999999-0000-0000-0000-000000000002') <> hh then
    raise exception 'FAIL: redeemer did not join the household';
  end if;
  if (select initials from profiles where id='99999999-0000-0000-0000-000000000002') <> 'RR' then
    raise exception 'FAIL: invite prefill did not apply';
  end if;
  if (select is_admin from profiles where id='99999999-0000-0000-0000-000000000002') then
    raise exception 'FAIL: an invited member must not be an admin by default';
  end if;
end $$;
\echo '  ok  redeem_invite joins the house with the prefilled identity'

-- Single-use codes must not work twice.
insert into auth.users (id, email, raw_user_meta_data)
values ('99999999-0000-0000-0000-000000000003','third@newhouse.com','{}');

do $$
declare c text;
begin
  select code into c from household_invites where full_name='Ravi Roommate';
  perform set_config('request.user_id', '99999999-0000-0000-0000-000000000003', false);
  begin
    perform redeem_invite(c);
    raise exception 'FAIL: a single-use invite was redeemed twice';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  a single-use invite cannot be redeemed twice'

-- ====================================================== rotation, mid-cycle
do $$
declare hh uuid; c uuid; n int; bad int;
begin
  select household_id into hh from profiles where id='99999999-0000-0000-0000-000000000001';
  select id into c from chores where household_id=hh and name='Dishes';

  select count(*) into n from chore_rotation where chore_id=c;
  if n <> 2 then raise exception 'FAIL: rotation should have 2 people after the join, got %', n; end if;

  -- positions must be a gapless 0..n-1 sequence or turn % n points at a hole
  if (select count(*) from chore_rotation where chore_id=c and position not in (0,1)) > 0 then
    raise exception 'FAIL: rotation positions are not contiguous';
  end if;

  -- every pending turn must now match the *new* rotation
  select count(*) into bad
  from chore_turns t
  where t.chore_id = c and t.status = 'pending'
    and t.assignee_id is distinct from rotation_assignee(t.chore_id, t.turn_number);
  if bad > 0 then
    raise exception 'FAIL: % pending turns were not resynced after someone joined', bad;
  end if;

  -- and the new person actually appears on the board
  if not exists (select 1 from chore_turns
                 where chore_id=c and status='pending'
                   and assignee_id='99999999-0000-0000-0000-000000000002') then
    raise exception 'FAIL: the new roommate never comes up in the rotation';
  end if;
end $$;
\echo '  ok  joining mid-cycle resyncs pending turns and puts you on the board'

-- History must survive a membership change.
do $$
declare hh uuid; c uuid; before_done int; after_done int;
begin
  select household_id into hh from profiles where id='99999999-0000-0000-0000-000000000001';
  select id into c from chores where household_id=hh and name='Dishes';

  perform set_config('request.user_id', '99999999-0000-0000-0000-000000000001', false);
  perform complete_turn((select id from chore_turns where chore_id=c and status='pending'
                         order by turn_number limit 1));

  select count(*) into before_done from chore_turns where chore_id=c and status='done';
  perform remove_from_rotations('99999999-0000-0000-0000-000000000002', hh);
  select count(*) into after_done from chore_turns where chore_id=c and status='done';

  if before_done <> after_done or before_done = 0 then
    raise exception 'FAIL: completed history changed when the rotation did (% -> %)',
      before_done, after_done;
  end if;

  if exists (select 1 from chore_turns where chore_id=c and status='pending'
             and assignee_id is null) then
    raise exception 'FAIL: removing someone left a pending turn unassigned';
  end if;
end $$;
\echo '  ok  removing someone renumbers cleanly and preserves history'

-- ====================================================== admin authorization
do $$
begin
  -- Ravi is a member, not an admin.
  perform set_config('request.user_id', '99999999-0000-0000-0000-000000000002', false);
  begin
    perform create_invite();
    raise exception 'FAIL: a non-admin created an invite';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    perform create_kiosk_device('Wall iPad');
    raise exception 'FAIL: a non-admin paired a kiosk';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;

  begin
    perform remove_member('99999999-0000-0000-0000-000000000001');
    raise exception 'FAIL: a non-admin removed someone';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  invite / kiosk / remove are admin-only'

-- ============================================================ kiosk binding
do $$
declare token text; resolved uuid; hh uuid;
begin
  perform set_config('request.user_id', '99999999-0000-0000-0000-000000000001', false);
  select household_id into hh from profiles where id='99999999-0000-0000-0000-000000000001';

  token := create_kiosk_device('Wall iPad');

  if exists (select 1 from kiosk_devices where token_hash = token) then
    raise exception 'FAIL: the raw kiosk token was stored instead of its hash';
  end if;

  resolved := resolve_kiosk_token(token);
  if resolved is distinct from hh then
    raise exception 'FAIL: kiosk token resolved to %, expected %', resolved, hh;
  end if;

  if resolve_kiosk_token('not-a-real-token') is not null then
    raise exception 'FAIL: a bogus kiosk token resolved to a household';
  end if;
end $$;
\echo '  ok  kiosk pairs to its own household, token stored only as a hash'
