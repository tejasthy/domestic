#!/usr/bin/env bash
# Runs the real migrations against stock Postgres 16 and exercises the
# rotation engine, the money views, and row-level security.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PSQL=(docker exec -i domestic-pgtest psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

docker rm -f domestic-pgtest >/dev/null 2>&1 || true
docker run -d --name domestic-pgtest -e POSTGRES_PASSWORD=test postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec domestic-pgtest pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

# The app role is created BEFORE the migrations, because that is how Supabase
# works — `authenticated` already exists when you run SQL. 0004 revokes UPDATE
# on profiles and re-grants it column by column; if the role did not exist yet,
# that protection would silently no-op.
echo "── role & migrations ──────────────────────────────────"
"${PSQL[@]}" <<'SQL'
-- Supabase keeps pgcrypto in `extensions`, not `public`, and it is already
-- installed when you run your first migration — so 0001's
-- `create extension if not exists "pgcrypto"` is a no-op there. Reproduce that
-- here, or a security-definer function pinned to `set search_path = public`
-- resolves digest()/gen_random_bytes() in the test container and fails in
-- production.
create schema if not exists extensions;
create extension if not exists "pgcrypto" with schema extensions;

create role domestic_app nologin;
grant usage on schema public to domestic_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to domestic_app;
alter default privileges in schema public grant execute on functions to domestic_app;
SQL
echo "  ok  pgcrypto in extensions + app role created (as in Supabase)"

"${PSQL[@]}" < "$HERE/auth_shim.sql"                   && echo "  ok  auth shim"
"${PSQL[@]}" < "$REPO/supabase/migrations/0001_init.sql"  && echo "  ok  0001_init.sql"
"${PSQL[@]}" < "$REPO/supabase/migrations/0002_logic.sql" && echo "  ok  0002_logic.sql"
"${PSQL[@]}" < "$REPO/supabase/migrations/0003_invites_and_oauth.sql" && echo "  ok  0003_invites_and_oauth.sql"
"${PSQL[@]}" < "$REPO/supabase/migrations/0004_multi_household.sql" && echo "  ok  0004_multi_household.sql"
"${PSQL[@]}" < "$REPO/supabase/migrations/0005_modules.sql" && echo "  ok  0005_modules.sql"
"${PSQL[@]}" < "$REPO/supabase/migrations/0006_devices.sql" && echo "  ok  0006_devices.sql"
"${PSQL[@]}" < "$REPO/supabase/migrations/0007_intro.sql" && echo "  ok  0007_intro.sql"
"${PSQL[@]}" < "$REPO/supabase/migrations/0008_pgcrypto_schema.sql" && echo "  ok  0008_pgcrypto_schema.sql"

# Only the auth-schema grants are left to do; everything in `public` came from
# the default privileges set above, so 0004's column-level revoke still stands.
"${PSQL[@]}" <<'SQL'
grant usage on schema auth to domestic_app;
grant select on auth.users to domestic_app;
grant execute on all functions in schema auth to domestic_app;
SQL
echo "  ok  auth schema readable by the app role"

echo
echo "── idempotency: apply every migration again ───────────"
for f in "$REPO"/supabase/migrations/*.sql; do
  "${PSQL[@]}" < "$f" >/dev/null || { echo "  FAIL re-applying $(basename "$f")"; exit 1; }
done
echo "  ok  migrations are safe to re-run"

echo
echo "── rotation engine & money ────────────────────────────"
"${PSQL[@]}" < "$HERE/smoke.sql"

echo
echo "── multi-household & invites ──────────────────────────"
"${PSQL[@]}" < "$HERE/multi.sql"
"${PSQL[@]}" < "$HERE/modules.sql"
"${PSQL[@]}" < "$HERE/devices.sql"

echo
echo "── row level security ─────────────────────────────────"
"${PSQL[@]}" < "$HERE/rls.sql"
"${PSQL[@]}" < "$HERE/escalation.sql"
"${PSQL[@]}" < "$HERE/intro.sql"

echo
echo "── chore admin, recurring expenses, AI config ─────────"
"${PSQL[@]}" < "$HERE/chore_admin.sql"
"${PSQL[@]}" < "$HERE/recurring_expenses.sql"
"${PSQL[@]}" < "$HERE/ai_config.sql"

echo
echo "All database checks passed."
