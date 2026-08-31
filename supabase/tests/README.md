# Database tests

Runs the real migrations against a throwaway Postgres 16 container and exercises
the parts that only exist in SQL: the rotation engine, the balance views, and
row-level security.

```bash
npm run test:db
```

Needs Docker running. It creates a `domestic-pgtest` container, tears down any
previous one, and leaves the container up afterwards so you can poke at it:

```bash
docker exec -it domestic-pgtest psql -U postgres
```

`auth_shim.sql` is a stand-in for the slice of Supabase's `auth` schema the
migrations touch (`auth.users`, `auth.uid()`), so the migrations run unmodified.
`auth.uid()` reads a session GUC, which is what lets the tests impersonate a
roommate — and, in `rls.sql`, an outsider.

RLS is checked as a non-superuser role (`domestic_app`). Testing as `postgres`
would pass no matter what the policies said, because superusers bypass RLS.
