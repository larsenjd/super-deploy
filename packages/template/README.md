# PostgreSQL schema

This project manages a PostgreSQL 18 schema with super-deploy: you edit the
desired schema, and super-deploy generates immutable, all-or-nothing
migrations from it.

## Getting started

```sh
git init
pnpm install
```

Initialise Git first: `pnpm install` then also installs the pre-commit hook
(`.husky/pre-commit`, via Husky), which runs `pnpm precommit` on every commit.
If you install before `git init`, run `pnpm install` again afterwards.

Nothing else is needed: `super-deploy.config.ts` runs a private PostgreSQL 18
server in `.super-deploy/postgres` (gitignored). It provides the throwaway
databases that rehearsals use and the local `dev` target, and starts on a free
port whenever a command needs it.

1. Describe the schema you want as `CREATE` statements in `.sql` files under
   `data-model/desired-schema/` (any file names and folders).
2. `pnpm exec super-deploy draft --name "add customers"` generates the draft's
   schema change in `data-model/draft/`.
3. `pnpm exec super-deploy finalize` rehearses the draft and freezes it as the
   next numbered migration in `data-model/migrations/`.
4. `pnpm exec super-deploy deploy --target dev` applies every pending
   migration to the target in one transaction.

Run `pnpm exec super-deploy` with no arguments for an interactive menu, or
`pnpm exec super-deploy --help` for every command. Add real targets (QA,
production) to `super-deploy.config.ts`; keep credentials out of it, for
example by reading a connection string from an environment variable.

## Adopting an existing database

To bring a database that already exists under management, add it as a target
in `super-deploy.config.ts` (before any draft or migration exists), then run
`pnpm exec super-deploy init --adopt <target>`. Its managed schema becomes the
desired schema and migration `00001-adopt`, which is recorded on that target
as already deployed. If the database holds anything super-deploy doesn't
support, nothing is written and every such object is listed: that includes
a `SECURITY DEFINER` routine and objects the deploy role doesn't own (see
"Permissions"). Grants, policies and row-level security on the target stay
as they are, left out of the desired schema; adoption says how many grants
and policies it left.

Functions (or other statements) that use dynamic SQL (`EXECUTE`) or call a
built-in whose effects escape the transaction (such as `pg_notify`) need an
override marker in the desired schema. Once nothing else is refused,
adoption run in a terminal lists them and asks for a reason for each: the
reason reviewers will read in `-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>`,
which adoption writes on the line before the statement. Until then, its
refusal names them, so you know which reasons it will ask for. An empty
answer cancels the adoption, writing nothing. Without a terminal (in CI, for
example) adoption refuses them like anything else it doesn't support. `finalize` and `validate` show these
overrides like any other.

## Permissions

super-deploy knows about one role: the deploy role, which it connects to a
target as, and which owns the managed schema and everything in it. Who else
may use the database is set up on each target outside super-deploy.

### What the desired schema declares

No privileges. The desired schema, and every pre-migration script,
post-migration script and seed data file, refuses grants, revokes,
`ALTER DEFAULT PRIVILEGES`, roles and role membership, `OWNER TO`, policies,
`ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY` and `SECURITY DEFINER`
routines. No override marker gets past these refusals. Every routine runs as
the role that calls it (`SECURITY INVOKER`, PostgreSQL's default).

super-deploy never compares, creates, revokes or resets the grants, default
privileges, policies and row-level security on a target. They are not drift,
`deploy` succeeds over them, and `init --adopt` leaves them out of the desired
schema. `rebuild` drops everything in the managed schema, with the grants and
policies on those objects, and leaves the schema itself, its grants and its
default privileges as they are.

### What each target needs set up outside super-deploy

- **The deploy role.** It must own the managed schema and everything in it,
  or be a member of the role that owns them (one granted `WITH INHERIT FALSE`
  doesn't count). `deploy`, `deploy-draft`, `status`, `mark` and
  `init --adopt` refuse a target where something in the managed schema
  belongs to another role, listing each object with the `ALTER ... OWNER TO`
  that fixes it. For `public`, which `pg_database_owner` owns, deploy as the
  database's owner. The deploy role also needs `CREATE` on the database for
  the first deployment, which creates the history schema (and the managed
  schema, if the target lacks it).
- **The application's roles**, their role membership and their database
  privileges: `CONNECT` (and `TEMPORARY`, if needed). super-deploy never
  creates or drops roles.
- **The application's grants and any policies.** The recommended way is
  default privileges for the deploy role, so every object a deployment
  creates is granted automatically. For example, once the managed schema
  `app` exists, run as the deploy role on each target:

  ```sql
  grant usage on schema app to app_reader, app_writer;
  alter default privileges for role deploy_role in schema app
    grant select on tables to app_reader;
  alter default privileges for role deploy_role in schema app
    grant select, insert, update, delete on tables to app_writer;
  ```

  Default privileges apply only to objects created afterwards: grant on what
  already exists too, e.g. `grant select on all tables in schema app to
  app_reader`.

  Two things to know about grants and policies made by hand:

  - A migration that drops and recreates a table (or another object) loses
    the grants and policies made on it by hand, and super-deploy can't
    notice. Default privileges grant the new object again; anything else has
    to be made again after the deployment.
  - A migration that changes the type of, or drops, a column a hand-made
    policy uses fails at deploy: PostgreSQL refuses while the policy depends
    on the column. Rehearsals can't catch it, because their databases have
    no hand-made policies. The deployment rolls back and PostgreSQL's error
    names the policy: drop the policy, deploy, then create it again.
- **External schemas** (`externalSchemas` in `super-deploy.config.ts`), which
  must exist on every target (`deploy` refuses otherwise), and grants on them
  and their objects. Routines run as their caller, so it's the application's
  roles that need these grants (and the deploy role too, if a migration's
  scripts fire a trigger that uses them). For example, a
  PL/pgSQL function `app_writer` calls that reads `auth.users` needs:

  ```sql
  grant usage on schema auth to app_writer;
  grant select on auth.users to app_writer;
  ```

  Rehearsals have no `auth` schema, so only PL/pgSQL bodies may reference it.

## Files

- `data-model/migrations/`: finalized migrations. Never edit them: they are
  read-only, and their hashes are checked by `super-deploy validate`.
- `data-model/draft/schema-change.sql`: generated; run `draft` again instead
  of editing it.
- `pnpm precommit` runs Biome, the type checker and
  `super-deploy validate --strict`. The pre-commit hook runs it before every
  commit.

## Renaming a column

`draft` can't tell a rename from a drop plus an add, so rename the column in
`data-model/draft/pre-migration.sql` and run `draft` again. If the column is
NOT NULL, rename its constraint too: PostgreSQL 18 names NOT NULL constraints
(`t_old_not_null`) and a column rename keeps the old name, so the rehearsal
would refuse the draft. For example,
`alter table t rename constraint t_old_not_null to t_new_not_null`.

## Seed data

Seed data goes in `data-model/draft/seed-data.sql`: `INSERT` statements with
column lists that reproduce a target's problem data. The draft's rehearsals
load it just before the pre-migration script, so they prove the scripts
handle it; it is never loaded once the migration is finalized.

Seed data must be synthetic or anonymised. It is committed to git with its
migration and kept forever as an audit record, so never copy production data
into it.
