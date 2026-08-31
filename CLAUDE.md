# Domestic — working notes

Chore and expense tracker for a four-person house. See README.md for setup.

## Model

Chores own a **fixed rotation** and a **monotonic turn counter**. Turn `N`
belongs to `rotation[N % rotation.length]`. This is derived, never stored as a
mutable pointer — so skipping, swapping, or back-dating a turn cannot desync the
order. Mirror this if you add chore features.

- `scheduled` chores have a `due_at` and are materialized ahead by
  `materialize_schedule()` out to `lookahead_days`.
- `on_demand` chores have no due date and keep `queue_depth` turns pending, via
  `top_up_queue()`. Flagging one just stamps `due_at = now()`.

## Rules

- **Money is integer cents, everywhere.** Never floats. `splitEqual` and
  `splitByWeight` are remainder-safe and must stay that way — the tests assert
  splits sum to the total exactly.
- **Business logic that must be atomic lives in plpgsql**, not in actions:
  `complete_turn`, `top_up_queue`, `materialize_schedule`, `accept_swap`.
- **RLS is the security boundary.** Policies go through `is_household_member()`
  / `current_household_id()`, both `SECURITY DEFINER` to avoid recursing into
  the profiles policy. Views must be `security_invoker = on`.
- `createAdminClient()` bypasses RLS. Route handlers and scripts only — never a
  Server Component reachable by a user.
- Server Components cannot set cookies. Kiosk pairing is a route handler for
  exactly this reason.
- Colors resolve through the semantic layer (`--surface-*`, `--ink-*`), not raw
  palette tokens, so dark mode stays a single override block.
- **Household membership comes from `household_invites`, keyed by email** — not
  from auth metadata, and not from the provider. `handle_new_user()` resolves
  the invite on first sign-in, so Google/magic-link/anything all work. Adding a
  roommate means adding an invite, never touching auth.
- Views must be declared `with (security_invoker = true)`. `= on` is
  semantically identical but Postgres stores the literal token and Supabase's
  linter only matches `true`, so it reports the view as SECURITY DEFINER.

## Multi-household

Nothing is hardcoded to 526 Detroit St. Anything reading data for a "current
household" must resolve it explicitly:

- **Users** — from `profiles.household_id`, enforced by RLS.
- **Devices** (kiosk, Home Assistant) — from a token in `kiosk_devices`,
  resolved by SHA-256 hash via `resolve_device_token(token, kind)`. Never a
  global env token: a shared secret cannot say which household it speaks for.
  Service-role reads bypass RLS, so every such query must filter by the resolved
  `household_id` by hand — that filter *is* the security boundary.

Rotation membership changes go through `add_to_rotations` /
`remove_from_rotations`, which renumber `position` to stay gapless and then call
`resync_pending_turns`. Pending turns are re-derived; completed turns are
history and must never be rewritten.

## Modules

`src/lib/modules.ts` is the registry; `household_modules` stores only which keys
a household enabled. Module keys are a stable contract — renaming one orphans
every household that toggled it. Add a new key and migrate.

A new module needs: an entry in `MODULES`, pages under the declared route
prefix, and `requireModule('key')` at the top of each page. A household with no
row for a module falls back to `default_modules()`, so shipping one needs no
backfill.

## Migrations

Append-only. `create or replace function` cannot add a parameter, even a
defaulted one — it creates an overload and every existing call becomes
ambiguous, so `drop function` the old signature first.

Column privileges are explicit since 0004: a new user-writable column on
`profiles` needs its own `grant update (col)`, or it is silently read-only in
production while working fine as superuser locally.

pgcrypto lives in the `extensions` schema on Supabase, not `public`, so 0001's
`create extension if not exists` is a no-op there. Any `security definer`
function calling `digest`, `gen_random_bytes`, `crypt`, or `hmac` needs `set
search_path = public, extensions` — `public` alone resolves on stock Postgres
and fails in production. `supabase/tests/run.sh` now installs pgcrypto into
`extensions` so the test container reproduces that layout.
