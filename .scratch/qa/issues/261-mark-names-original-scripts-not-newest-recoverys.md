# 261: mark's confirmation names the original migration's scripts, not those of the Recovery a deploy would run

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** disp
**Round:** 3

## What I did
Project with `managedSchema: "app"` and a shared-server target `app` (`postgresTarget({ env: "APP_DATABASE_URL" })`, deploy role `qa3_disp_deploy`, not a superuser).

```sql
-- data-model/desired-schema/s.sql (migration 1 "base")
create domain positive_int as integer constraint positive_int_check check (value > 0);
create type address as (street text, city text);
create table people (id bigint generated always as identity primary key, name text not null, age positive_int, home address);
-- added for migration 2 "pets"
create table pets (id bigint generated always as identity primary key, owner_id bigint not null,
  constraint pets_owner_fk foreign key (owner_id) references people (id));
```

Migration 2's `pre-migration.sql`: `insert into app.people (name) values ('from pre');`

Then a Recovery of migration 2 with a different pre-migration script:

```sh
pnpm exec super-deploy recovery --migration 2
echo "insert into app.people (name) values ('from recovery pre');" > data-model/draft/pre-migration.sql
echo "insert into app.people (name) values ('recovery seed');" > data-model/draft/seed-data.sql
pnpm exec super-deploy finalize      # Finalized Recovery 1 of migration 00002-pets
```

Put the target at migration 1 (`rebuild --target app --to 1`, YES), ran migration 2's `schema-change.sql` on it by hand as the deploy role, then:

```sh
pnpm exec super-deploy mark --target app
```

## Expected
README: "The next `deploy` to a target that hasn't recorded migration 8 runs its newest Recovery in place of the original scripts", and for `mark`: "None of the migration's files run ... make their changes by hand too ... The confirmation names each script that won't run."

So the box should name the scripts a deployment would have run here: `00002-pets/recoveries/recovery-1/pre-migration.sql` (or at least say the migration has a Recovery and that its scripts are the ones to reproduce).

## Actual
```
│  The target matches a replica of migrations up to 00002-pets (column order aside), and the deploy role owns everything in its managed schema.
│  Its schema change and scripts are not run: only the target's history schema records it, as marked.
│  00002-pets/pre-migration.sql will not run: make the changes it makes by hand before typing YES
```

It tells me to reproduce the original `pre-migration.sql`, which is the script the Recovery exists to replace (the one that failed somewhere). Recovery 1 isn't mentioned at all. After YES the target records migration 2 as `marked` with `recovery: null`.

By contrast, `rebuild --to 2` on the same target lists `00002-pets (Recovery 1)` and runs the Recovery's script.

## Notes
A user following the box would hand-apply the original data change (e.g. a backfill that broke on some rows) instead of the corrected one. Guess: `mark` looks up scripts from the migration folder only, not its newest Recovery.
