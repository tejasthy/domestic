\set ON_ERROR_STOP on

set role domestic_app;
select set_config('request.user_id', 'cccccccc-0000-0000-0000-000000000003', false);

do $$
begin
  update profiles set intro_seen_at = now() where id = auth.uid();
  if (select intro_seen_at from profiles where id = auth.uid()) is null then
    raise exception 'FAIL: a member cannot record that they saw the intro';
  end if;

  -- The new grant must not have widened anything else.
  begin
    update profiles set is_admin = true where id = auth.uid();
    raise exception 'FAIL: the intro grant re-opened is_admin';
  exception
    when insufficient_privilege then null;
    when others then if sqlerrm like 'FAIL:%' then raise; end if;
  end;
end $$;
\echo '  ok  intro_seen_at is writable without re-opening privileged columns'

reset role;
