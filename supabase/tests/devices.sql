\set ON_ERROR_STOP on

do $$
declare hh uuid; kiosk_tok text; ha_tok text;
begin
  perform set_config('request.user_id', '99999999-0000-0000-0000-000000000001', false);
  select household_id into hh from profiles where id='99999999-0000-0000-0000-000000000001';

  kiosk_tok := create_device('Kitchen tablet', 'kiosk');
  ha_tok    := create_device('Home Assistant', 'home_assistant');

  if resolve_device_token(kiosk_tok, 'kiosk') is distinct from hh then
    raise exception 'FAIL: kiosk token did not resolve to its household';
  end if;
  if resolve_device_token(ha_tok, 'home_assistant') is distinct from hh then
    raise exception 'FAIL: HA token did not resolve to its household';
  end if;

  -- A kiosk token must not unlock the Home Assistant surface, or vice versa.
  if resolve_device_token(kiosk_tok, 'home_assistant') is not null then
    raise exception 'FAIL: a kiosk token was accepted as a Home Assistant token';
  end if;
  if resolve_device_token(ha_tok, 'kiosk') is not null then
    raise exception 'FAIL: an HA token was accepted as a kiosk token';
  end if;

  if resolve_device_token('garbage', 'kiosk') is not null then
    raise exception 'FAIL: a bogus token resolved';
  end if;
end $$;
\echo '  ok  device tokens are scoped to one household and one kind'

-- A device from one house must never resolve to another.
do $$
declare tok text; other uuid; mine uuid;
begin
  perform set_config('request.user_id', '88888888-0000-0000-0000-000000000001', false);
  select household_id into mine from profiles where id='88888888-0000-0000-0000-000000000001';
  tok := create_device('Other house tablet', 'kiosk');

  select household_id into other from profiles where id='99999999-0000-0000-0000-000000000001';
  if resolve_device_token(tok, 'kiosk') = other then
    raise exception 'FAIL: a device token crossed household boundaries';
  end if;
  if resolve_device_token(tok, 'kiosk') is distinct from mine then
    raise exception 'FAIL: device token did not resolve to its own household';
  end if;
end $$;
\echo '  ok  a device token never resolves to another household'
