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
support, nothing is written and every such object is listed.

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

### What the desired schema declares

The desired schema declares who may use what it defines, and super-deploy
deploys exactly that:

- Grants on its objects, e.g. `grant select on orders to app_reader`.
- `USAGE` on the managed schema, e.g. `grant usage on schema app to app_reader`.
  A managed schema other than `public` needs this, or no role but the deploy
  role can reach its objects. `CREATE` and `ALL` on the schema are refused,
  as are grants on any other schema.
- Revokes of PostgreSQL's default `PUBLIC` privileges on its objects:
  `revoke execute on function f() from public` (also procedures),
  `revoke usage on type t from public` (also domains) and, when the managed
  schema is `public`, `revoke usage on schema public from public`. Every
  other `REVOKE` is refused: to take a grant away, remove the `GRANT`.

For example, a `SECURITY DEFINER` function that only `app_writer` may call:

```sql
create function archive_order(id bigint) returns void
  language sql security definer set search_path = public, pg_catalog
  as $$ update orders set archived = true where orders.id = archive_order.id $$;

revoke execute on function archive_order(bigint) from public;
grant execute on function archive_order(bigint) to app_writer;
```

Grants are part of the schema: a grant or revoke made by hand on a target,
including on the managed schema itself, is drift, and `deploy` refuses until
it is undone (`status` lists it). `rebuild` leaves the managed schema's grants
exactly as the migrations declare. It can only revoke grants the deploy role
may revoke: if an administrator owns the managed schema and granted it to
other roles by hand, `rebuild` fails without changing anything, naming each
such grant, until the owner revokes them.

### What each target needs set up outside super-deploy

- **Roles and role membership.** super-deploy never creates or drops roles.
  Every role the desired schema grants to must exist on a target before
  deploying (`deploy` refuses otherwise); rehearsals create placeholder
  `NOLOGIN` roles for them.
- **Database privileges**: `CONNECT` (and `TEMPORARY`, if needed) for the
  application's roles.
- **The deploy role's own privileges.** It owns every object it deploys, and
  a `SECURITY DEFINER` function runs as it. It needs `CREATE` on the database
  for the first deployment to create the history schema (and the managed
  schema, if the target lacks it). It should own the managed schema; if an
  administrator owns it instead, grant the deploy role
  `usage, create on schema app ... with grant option` (the grant option lets
  it grant `USAGE` on the schema). These privileges, and the owner's, aren't
  drift, and `rebuild` and `init --adopt` leave them alone. For
  `public`, deploy as the database's owner, who owns `public` by default.
- **Grants on external schemas and their objects** (`externalSchemas` in
  `super-deploy.config.ts`). A `SECURITY DEFINER` function runs as the deploy
  role, so that role needs them, not the application's roles. For example,
  a trigger that copies a user's name from an `auth` schema:

  ```sql
  create function set_author_name() returns trigger
    language plpgsql security definer set search_path = pg_catalog
    as $$
    begin
      new.author_name := (select u.name from auth.users u where u.id = new.author_id);
      return new;
    end
    $$;

  create trigger posts_set_author_name before insert on posts
    for each row execute function set_author_name();

  revoke execute on function set_author_name() from public;
  ```

  Every target then needs, outside super-deploy:

  ```sql
  grant usage on schema auth to deploy_role;
  grant select on auth.users to deploy_role;
  ```

  Rehearsals have no `auth` schema, so only PL/pgSQL bodies may reference it.

Don't use `ALTER DEFAULT PRIVILEGES` for the deploy role in the managed
schema (for example `alter default privileges for role deploy_role in schema
app grant select on tables to app_reader`). The objects a deployment creates
would get grants that rehearsals don't have, and the next `deploy` refuses
the target as drifted. Declare the grants in the desired schema instead.

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
