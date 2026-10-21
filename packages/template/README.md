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
If you install before `git init`, run `pnpm install` again afterwards. The
hook lets you commit a draft in progress; CI should refuse it until it is
finalized (see
[The files of a draft and a migration](#the-files-of-a-draft-and-a-migration)).

Nothing else is needed: `super-deploy.config.ts` runs a private PostgreSQL 18
server in `.super-deploy/postgres` (gitignored). It provides the throwaway
databases that rehearsals use and the local `dev` target, and starts on a free
port whenever a command needs it. `dev` is deployed as the role `deployer`,
which owns the `dev` database and isn't a superuser, like a real target's
deploy role (see [Permissions](#permissions)); the server's superuser
`super_deploy` only sets the server up and runs the rehearsals.

1. Describe the schema you want as `CREATE` statements in `.sql` files under
   `data-model/desired-schema/` (any file names and folders). See
   [What the desired schema supports](#what-the-desired-schema-supports)
   for what they may create.
2. `pnpm exec super-deploy draft --name "add customers"` generates the draft's
   schema change in `data-model/draft/`.
3. `pnpm exec super-deploy finalize` rehearses the draft and freezes it as the
   next numbered migration in `data-model/migrations/`.
4. `pnpm exec super-deploy deploy --target dev` applies every pending
   migration to the target in one transaction.

Run `pnpm exec super-deploy` with no arguments for an interactive menu, or
`pnpm exec super-deploy --help` for every command. To deploy to a real
database (QA, production), add it as a target: see
[Adding a real target](#adding-a-real-target).

## What the desired schema supports

The desired schema may hold only the statements below; super-deploy refuses
everything else. `draft`, `rehearse`, `finalize` and `validate` list every
refused statement on a line of its own, as `<file>:<line>: <reason> [<rule>]`.
Problems between statements (a reference to something the desired schema
doesn't create, a dependency cycle, an object created twice) are listed once
nothing else is refused.
Messages that say something "is not supported in V1" mean super-deploy's
first version: these may be supported later, but none is yet.

### Supported

- Tables: identity columns, defaults, stored generated columns, collations,
  and primary key, unique, check, foreign key, exclusion and NOT NULL
  constraints, deferrable or not.
- `ALTER TABLE ... ADD CONSTRAINT`, one constraint per statement, such as a
  foreign key between tables defined in different files.
- Indexes: unique, partial and expression indexes, with any index method
  and storage parameters.
- Views (with the options `security_invoker`, `security_barrier` and
  `check_option`) and materialized views.
- Functions and procedures in `sql` or `plpgsql`, and triggers.
- Domains and composite types.
- `COMMENT ON` the objects above.
- `CREATE EXTENSION plpgsql`, which is installed in every database anyway.

### Refused

Each of these is refused as `[unsupported-object]`. The most common first:

- **Enums** (`CREATE TYPE ... AS ENUM`): use a lookup table with a foreign
  key, or a CHECK constraint. A value added to an enum can't be used until
  its transaction commits, and a deployment runs every pending migration in
  one transaction.
- **Extensions other than `plpgsql`**, including `pgcrypto`, `citext`,
  `pg_trgm`, `uuid-ossp`, `btree_gist`, PostGIS and pgvector. An
  extension's install script is code the rules can't check, some escape the
  transaction, and rehearsals would need the same extensions as every
  target. For UUIDs, PostgreSQL 18 has `gen_random_uuid()` and `uuidv7()`
  built in.
- **Standalone sequences** (`CREATE SEQUENCE`) and **`serial` columns**
  (`serial`, `bigserial`, `smallserial`, `serial4`, `serial8`, `serial2`):
  use an identity column, `bigint generated always as identity`.
- **Partitioned tables** (`PARTITION BY`, and partitions, `PARTITION OF`):
  attaching and detaching partitions takes heavy locks, and recurring
  partition maintenance doesn't fit a declarative schema.

Other object types:

- rules (`CREATE RULE`) and event triggers;
- foreign tables and foreign data wrappers (with their servers and user
  mappings);
- publications and subscriptions;
- custom casts, operators, operator classes, operator families,
  aggregates, collations, conversions, transforms and access methods;
- text-search configurations (and their dictionaries, parsers and
  templates);
- range types, and base types (use a domain or a composite type instead);
- procedural languages, and functions in any language but `sql` and
  `plpgsql`;
- `CREATE STATISTICS`.

Table, view and routine features:

- table inheritance (`INHERITS`) and typed tables (`CREATE TABLE ... OF
  type`);
- temporary tables and temporary views;
- `NOT ENFORCED` constraints, and constraint triggers;
- virtual generated columns: add `STORED` (in PostgreSQL 18 a generated
  column without `STORED` is virtual);
- routine options other than `LANGUAGE`, volatility, `STRICT`,
  `LEAKPROOF`, `PARALLEL`, `COST`, `ROWS` and `SET` (such as `WINDOW` and
  `SUPPORT`);
- view options other than the three above.

Physical storage settings:

- unlogged tables;
- tablespaces, on tables, indexes and constraints;
- table and materialized view storage parameters (`WITH (fillfactor =
  ...)`) and table access methods (`USING heap`);
- column `STORAGE` and `COMPRESSION` settings.

Grants, roles, ownership, policies, row-level security and `SECURITY
DEFINER` are refused too: they are set up on each target outside
super-deploy (see [Permissions](#permissions)).

### Rules for writing it

- **Name every index and constraint**: `create index customers_email_idx on
  customers (email)`, `constraint orders_total_check check (total >= 0)`.
  Primary keys and NOT NULL constraints are the exceptions: PostgreSQL names
  them from the table and column alone (`orders_pkey`,
  `orders_total_not_null`). For anything else it picks a name that isn't
  taken yet (`orders_total_check1`), so the name could depend on the order
  the files load in, and differ between rehearsals and targets. Unnamed
  ones are refused as `[unnamed-index]` and `[unnamed-constraint]`.
- **Define each object exactly once**: no `IF NOT EXISTS`, `OR REPLACE` or
  `ALTER TABLE IF EXISTS`, so no definition can silently replace or skip
  another depending on load order.
- **One managed schema**: no `CREATE SCHEMA`. super-deploy creates the
  managed schema (`managedSchema`, see [Project settings](#project-settings))
  itself. Write object names unqualified (or qualified with the managed
  schema). Statements may refer only to the managed schema and
  `pg_catalog`; PL/pgSQL bodies may also refer to `externalSchemas`.
- **Only `ALTER TABLE ... ADD CONSTRAINT`** among `ALTER` statements:
  declare columns and everything else in `CREATE TABLE`, written out (not
  copied with `LIKE`).
- **No data or session statements**: no `INSERT`, `UPDATE`, `DELETE`, `DO`
  or `SET`. Data changes go in a draft's scripts (see
  [The files of a draft and a migration](#the-files-of-a-draft-and-a-migration)).
- **No `CREATE INDEX CONCURRENTLY`**: it can't run inside the deployment's
  transaction.
- **No dynamic SQL or transaction-escaping built-ins** without a reason:
  `EXECUTE` in a PL/pgSQL body, and built-ins whose effects escape the
  transaction (such as `pg_notify`), are refused unless an override marker,
  `-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>` on the line before the
  statement, says why (see [Overriding a refusal](#overriding-a-refusal)).
  No marker gets past any other refusal.

## Configuration

`super-deploy.config.ts` exports `defineConfig({ ... })`. These are all its
settings; super-deploy refuses any other.

### Project settings

- `postgresVersion`: required, and must be `18`.
- `rehearsal`: required. Provides the throwaway databases rehearsals use.
  The generated config uses its private embedded server
  (`postgres.rehearsal`). `postgresRehearsal({ env: "REHEARSAL_DATABASE_URL" })`,
  imported from `super-deploy`, uses an existing PostgreSQL 18 server
  instead; its login needs `CREATEDB`.
- `targets`: the named targets, such as `dev`, `qa` and `prod` (see
  [Targets](#targets)). Default none. A target's name may contain letters,
  digits, `-` and `_`.
- `managedSchema`: the one schema super-deploy manages. The desired schema
  describes it, and deployments create and change everything in it.
  Default `public`.
- `historySchema`: the schema super-deploy creates on each target to record
  which migrations it ran, every deployment attempt, and whether the target
  is disposable. Default `deployment_history`. It must differ from
  `managedSchema`.
- `externalSchemas`: schemas outside the managed schema that PL/pgSQL
  routines in the desired schema may refer to, such as `["auth"]`.
  super-deploy neither creates them nor reproduces them in rehearsals: each
  must already exist on every target (see "Permissions"). Default none.
- `directory`: the folder holding `desired-schema/`, `draft/` and
  `migrations/`, relative to the config file and inside the project.
  Default `data-model`.

Schema names are lowercase PostgreSQL identifiers (letters, digits and `_`),
and none may be a system schema (`pg_...`, `information_schema`).

### Targets

Each entry in `targets` is one target:

- `adapter`: required. How to connect to the target:
  `postgres.target("<database>")` for a database on the private embedded
  server (created on first use, owned by and deployed as the role
  `deployer`), or `postgresTarget(...)` for an existing server (see
  [Adding a real target](#adding-a-real-target)).
- `lockTimeout`: how long a statement waits for a lock on the target before
  failing (PostgreSQL's `lock_timeout`). A deployment that hits it rolls back
  as a whole. Default `"5s"`.
- `statementTimeout`: how long one statement may run on the target
  (PostgreSQL's `statement_timeout`). Default none: the server's own
  setting for the deploy role applies.
- `connectTimeout`: how long connecting to the target may take before the
  command fails, such as when the host is firewalled or unreachable.
  Default `"10s"`. (`connect_timeout` in a connection string is ignored.)

`lockTimeout` and `statementTimeout` apply inside deployments, and to
super-deploy's reads of the target's schema (its drift check, and
`init --adopt`). A duration is a positive whole
number of milliseconds (`500`) or a string with the unit `ms`, `s`, `min` or
`h`: `"500ms"`, `"5s"`, `"2min"`, `"1h"`.

### Adding a real target

A real target connects to an existing PostgreSQL 18 server with
`postgresTarget`. Import it beside `defineConfig`, and give each target the
name of the environment variable holding its connection string:

```ts
import { defineConfig, postgresTarget } from "super-deploy";

export default defineConfig({
  // ...
  targets: {
    dev: { adapter: postgres.target("dev") },
    qa: { adapter: postgresTarget({ env: "QA_DATABASE_URL" }) },
    prod: {
      adapter: postgresTarget({ env: "PROD_DATABASE_URL" }),
      lockTimeout: "2s",
    },
  },
});
```

The generated `super-deploy.config.ts` has the `qa` line, commented out.

`postgresTarget({ env: "QA_DATABASE_URL" })` reads the variable only when a
command connects to `qa`, so every other command and target works without
it. A command that uses `qa` while the variable is unset or empty fails
before connecting, changing nothing:
`Target qa: environment variable QA_DATABASE_URL is not set` (or `is
empty`). The variable holds a connection string such as
`postgresql://deploy_role:password@db.example.com:5432/app`; one that isn't a
`postgres://` or `postgresql://` URL is refused the same way.

`postgresTarget({ connectionString: "postgresql://..." })` takes the
connection string itself instead. The config is committed to Git, so keep
credentials out of it: use `{ env }` for any connection string with a
password in it.

**The deploy role is the user in the connection string**: `deploy_role` in
the example above. super-deploy runs everything on the target as that user,
and "Permissions" says what it needs.

## Adopting an existing database

To bring a database that already exists under management, add it as a target
in `super-deploy.config.ts` (see [Adding a real target](#adding-a-real-target);
before any draft or migration exists), and set `managedSchema` if its schema
isn't `public` (see [Project settings](#project-settings)). Then run
`pnpm exec super-deploy init --adopt <target>`. Its managed schema becomes the
desired schema and migration `00001-adopt`, which is recorded on that target
as already deployed. If the target has no schema of that name (usually a
typo in `managedSchema`), adoption refuses and writes nothing. If the
database holds anything super-deploy doesn't support (see
[What the desired schema supports](#what-the-desired-schema-supports)),
nothing is written and every such object is listed: that includes a
`SECURITY DEFINER` routine, objects owned by another role (see
"Permissions"), and views, foreign keys, `LANGUAGE sql` functions and the
like that reference an external schema (only PL/pgSQL bodies may). The
refusal ends with what to do: change the target, declare a schema a
PL/pgSQL body references in `externalSchemas`, or run adoption in a
terminal to give override reasons (below). Grants,
policies and row-level security on the target stay
as they are, left out of the desired schema; adoption says how many grants
and policies it left.

Functions (or other statements) that use dynamic SQL (`EXECUTE`) or call a
built-in whose effects escape the transaction (such as `pg_notify`) need an
override marker in the desired schema (see
[Overriding a refusal](#overriding-a-refusal)). Once nothing else is refused,
adoption run in a terminal lists them and asks for a reason for each: the
reason reviewers will read in `-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>`,
which adoption writes on the line before the statement. Until then, its
refusal names them, so you know which reasons it will ask for. An empty
answer cancels the adoption, writing nothing. Without a terminal (in CI, for
example) adoption refuses them, saying to run it in a terminal. `finalize` and `validate` show these
overrides like any other.

## Permissions

super-deploy knows about one role: the deploy role, which it connects to a
target as (the user in the target's connection string, see
[Adding a real target](#adding-a-real-target)), and which owns the managed
schema (`managedSchema`, see [Project settings](#project-settings)) and
everything in it. Who else
may use the database is set up on each target outside super-deploy.

### What the desired schema declares

No privileges. The desired schema, and every file a deployment runs
(scripts, seed data and generated schema changes alike), refuses grants,
revokes, `ALTER DEFAULT PRIVILEGES`, roles and role membership, `OWNER TO`,
`REASSIGN OWNED`, `DROP OWNED`, policies, turning row-level security on or
off (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and the like) and
`SECURITY DEFINER` routines. No override marker gets past these refusals. Every routine runs as
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
  doesn't count). `deploy`, `deploy-draft`, `mark` and `init --adopt`
  refuse a target where something in the managed schema is owned by another
  role, listing each object with the `ALTER ... OWNER TO` that fixes it;
  `status` lists them under "Deploy would refuse". For `public`, which `pg_database_owner` owns, deploy as the
  database's owner. The deploy role also needs `CREATE` on the database for
  the first deployment, which creates the history schema (and the managed
  schema, if the target lacks it).
- **The application's roles**, their role membership and their database
  privileges: `CONNECT` (and `TEMPORARY`, if needed). super-deploy never
  creates or drops roles, apart from `deployer` on its private embedded
  server.
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
- **External schemas** (`externalSchemas` in `super-deploy.config.ts`, see
  [Project settings](#project-settings)), which
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

## The files of a draft and a migration

`data-model/draft/` holds the one draft, and each folder in
`data-model/migrations/` (`00001-add-customers`, ...) one finalized
migration. A deployment runs these files of a migration, in this order, in
the deployment's one transaction:

1. `pre-migration.sql` (optional, hand-written): runs before the schema
   change. It may change data and structure, such as renaming a column (see
   [Renaming a column](#renaming-a-column)).
2. `schema-change.sql` (generated by `draft`): takes the schema from the
   previous migration to the desired schema. Never edit it: change the
   desired schema (or the pre-migration script) and run `draft` again.
3. `post-migration.sql` (optional, hand-written): runs after the schema
   change, and may only change data, such as backfilling a new column.

`seed-data.sql` (optional) is loaded only by the draft's own rehearsals,
just before the pre-migration script (see [Seed data](#seed-data)). It is
never run by a deployment.

No other file in a draft or migration is run. `draft.json` holds the draft's
name, and hashes of the desired schema and the schema change `draft`
generated, so `rehearse` can tell whether running `draft` again would help.

Finalized migrations are read-only and hashed: never edit them.
`super-deploy validate` checks their hashes, and `pnpm precommit` runs
Biome, the type checker and `super-deploy validate --strict --allow-draft`
(the pre-commit hook runs it before every commit). To change the newest
migration before any target has run it, see
[Changing your mind](#changing-your-mind).

The hook blocks a commit on every error `validate` finds (an edited or
renamed finalized migration, a refused statement) and, through `--strict`,
on every warning except a draft in progress. A draft in progress, an
unfinalized draft or desired-schema changes not yet drafted, is listed as a
warning and doesn't block, so you can commit a draft with its hand-written
scripts and push it for review before finalizing it. In CI, run
`pnpm exec super-deploy validate --strict` without `--allow-draft`: it fails
until the draft is finalized and the desired schema matches the newest
migration, so work in progress can't be merged.

## Overriding a refusal

Two refusals are risks rather than impossibilities: dynamic SQL (`EXECUTE`
in a PL/pgSQL body, `[plpgsql-dynamic-sql]`) and calls to built-ins whose
effects escape the transaction, such as `pg_notify` or `setval`
(`[denylisted-call]`). When such a statement is safe, accept it with an
override marker on its own line, directly before the statement:

```sql
-- OVERRIDE SUPER-DEPLOY REFUSAL: loads the staging table named by the caller
create function load_staging(source text) returns void
language plpgsql as $$
begin
  execute format('insert into staging select * from %I', source);
end
$$;
```

- It works in the desired schema and in the hand-written files of a draft
  (`pre-migration.sql`, `post-migration.sql` and `seed-data.sql`). `draft`
  copies a desired-schema marker into `schema-change.sql` for the statement
  that changes the same object.
- It applies to the one statement after it, and needs a reason: a marker
  without one, written any other way, or not directly before a statement is
  refused.
- It overrides only those two refusals. A marker before a statement that
  breaks any other rule (transaction control, privileges, unsupported
  objects, ...) doesn't get it past them, and a marker before a statement
  that breaks no rule is refused as unused.
- Every override is recorded with its file, line, object and reason:
  `finalize` lists them and writes them to the migration's `metadata.json`,
  and `validate` lists them, so reviewers see each exception.

The refusals a marker can override end with how to write it.

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
(`draft`, `rehearse` and `finalize`) load it just before the pre-migration
script, so they prove the scripts handle it. Once the migration is
finalized, seed data is kept with it but never loaded again: deployments
and `rebuild` never load it. Only `deploy-draft --with-seed` loads it onto a
target, and only onto a disposable one (see
[Disposable targets](#disposable-targets-and-the-guarded-commands)).

Seed data must be synthetic or anonymised. It is committed to git with its
migration and kept forever as an audit record, so never copy production data
into it.

## Destructive changes

A statement is destructive when it drops structure or deletes data:

- `DROP` statements, and dropping a column, an attribute or a constraint;
- changing a column's type, unless it is a known widening of the current
  type (such as `integer` to `bigint`);
- `DELETE` (including `MERGE ... DELETE`) and `TRUNCATE`.

A statement on an object created earlier in the same migration isn't
destructive, and neither is dropping a view, index, function, trigger, type
or constraint that the migration then creates again (as `draft` does to
change one). A table or column dropped and created again has lost its rows,
so that stays destructive, and so does anything with `CASCADE`.

Narrowing a column is destructive in a quieter way. `draft` changes a
column's type with an explicit cast (`USING col::newtype`), so values that
don't fit the new type are cut short or rounded, without an error, on every
target. That applies to a shorter `varchar(n)`, `char(n)`, `bit(n)` or
`varbit(n)`, such as `text` to `varchar(5)`, and to a `numeric` with fewer
decimal places, such as `numeric(6,2)` to `numeric(4,1)`. The deployment
doesn't fail. `draft` says how many values in the rehearsal data don't fit,
and `finalize` asks for the change to be acknowledged. If those values
matter, shorten or move them in the pre-migration script.

`rehearse` lists a draft's destructive statements, and `finalize` needs them
acknowledged. In a terminal, `finalize` lists them and asks. Without a
terminal (in CI, for example) it refuses, listing them:
`pass --acknowledge-destructive to finalize it anyway`. Pass the flag only after
reviewing the statements: acknowledging says you mean the migration to drop
this structure or data on every target it reaches. `finalize` records the
acknowledged statements under `destructive` in the migration's
`metadata.json`, which is hashed with the migration, so reviewers see them
in the commit. `deploy` doesn't ask again: it runs them like any other
statement.

## When a deploy fails

A deployment runs every pending migration in one transaction. When
PostgreSQL refuses a statement, for example because the target holds data a
new constraint rejects, the whole transaction is rolled back: the target is
as it was before the deployment, and records none of its migrations. Other
migrations in the same deployment are rolled back too.

The migration that failed is finalized, so it can't be edited, and targets
that already ran it keep it. Instead, give it a **Recovery**: replacement
scripts and seed data for the targets that haven't run it yet. For a failure
in migration 8:

1. `pnpm exec super-deploy recovery --migration 8` starts a Recovery draft
   in `data-model/draft/` (there must be no other draft: finalize it or run
   `discard-draft` first). The draft holds migration 8's schema change and a
   copy of its `pre-migration.sql`, `post-migration.sql` and
   `seed-data.sql` (those of its newest Recovery, if it has one).
2. In `seed-data.sql`, reproduce the rows the target refused, with synthetic
   values.
3. Fix `pre-migration.sql` (or `post-migration.sql`) so it handles them, for
   example by updating those rows before the schema change.
4. `pnpm exec super-deploy rehearse` runs the Recovery after its seed data,
   and proves it ends in exactly the structure migration 8 ends in.
5. `pnpm exec super-deploy finalize` freezes it as
   `data-model/migrations/00008-.../recoveries/recovery-1/`. Migration 8's
   own files and hashes don't change.
6. The next `deploy` to a target that hasn't recorded migration 8 runs its
   newest Recovery in place of the original scripts, and records which one
   it ran. `status` and `deploy` show it next to the migration
   (`00008-... (Recovery 1)`), and `status`'s recent attempts name it too.

The schema change never changes: a Recovery always runs its migration's
`schema-change.sql`, and `draft` refuses to regenerate it. Don't edit the
draft's copy: `rehearse` and `finalize` refuse a Recovery draft whose schema
change is no longer the migration's.

## Changing your mind

Three commands throw unfinished work away:

- `discard-draft` deletes the draft (`data-model/draft/`). The desired
  schema stays as it is, so the next `draft` starts again from it.
- `restore-schema` resets the desired schema (its `.sql` files) to the
  newest migration's snapshot, and deletes any draft.
- `unfinalize` moves the newest migration back into the draft, writable
  again, and resets the desired schema to the snapshot frozen with it, so
  finalizing again reproduces the migration. When the newest migration has
  Recoveries, it moves the newest Recovery back into a Recovery draft
  instead, leaving the desired schema alone. `--recovery-of N` does that for
  migration N's newest Recovery.

Each asks first in a terminal when it would delete or overwrite something:
a draft, or desired-schema files that differ from the snapshot being
restored. Without a terminal it refuses, naming those paths, unless you pass
`--acknowledge-overwrite`.

**Never `unfinalize` a migration (or Recovery) that any target has
recorded**, even only `dev`. That target records the migration's name and
hashes, so once the migration is gone or finalized differently, `deploy`
refuses the target (for example
`the target records migration 00008-tweaks with content hash ..., but the repo's is ...`).
To change something a target has run, finalize a new migration, or a
Recovery for the targets that haven't run it. If you already unfinalized
one, restore its original folder and `data-model/migrations/index.json`
from Git, then run `pnpm exec super-deploy validate` to make the restored
files read-only again.

## Disposable targets and the guarded commands

A disposable target is one you may wipe and experiment on, such as your own
`dev` database. Four commands change a target outside the normal
draft-finalize-deploy path:

- **`disposable --target X --set yes|no`** flags target `X` as disposable,
  or not. The flag lives in the target itself, in its history schema
  (`deployment_history` by default), not in `super-deploy.config.ts`, so no
  config change can make production disposable. Before you type `YES` to
  mark it disposable, it shows how many tables the managed schema holds
  and about how many rows (PostgreSQL's estimate), so a database full of
  real data stands out.
- **`deploy-draft --target X`** tries the current, unfinalized draft on a
  disposable target, so its scripts meet the target's data before you
  finalize. The target must have no pending migrations (a Recovery draft of
  migration N needs the target at N-1). The draft's pre-migration script,
  schema change and post-migration script run in one transaction, without a
  rehearsal first. `--with-seed` loads the draft's seed data first, which
  may clash with data already on the target. The target then records that
  it holds the draft, not a migration: `deploy`, `mark` and another
  `deploy-draft` refuse it, and `status` doesn't check it for drift, until
  `rebuild` resets it.
- **`rebuild --target X --to N`** resets a disposable target to migration
  N, in one transaction. It drops everything in the managed schema, with
  `CASCADE`. The confirmation lists what in the managed schema no recorded
  migration created (what `status` reports as only on the target, from a
  throwaway replica of the recorded migrations), up to 10 objects. Objects
  in other schemas that depend on the managed schema are dropped too:
  a view on a managed table, a foreign key to one, a column of a managed
  type (with its data). The confirmation lists each of them under "Also
  drops, outside schema ...", and if that list changes while it waits for
  `YES`, rebuild refuses without changing anything. It refuses before
  asking when the managed schema holds something the deploy role can't
  drop, such as an extension a superuser installed, naming each object and
  its owner. The managed schema itself stays, with its owner, grants and
  default privileges. Then it deletes the target's record of migrations and of any
  deployed draft, and runs migrations 1 to N as a deployment does, each as
  its newest Recovery if it has one. It never loads seed data, and keeps
  the attempt log and the disposable flag. In the menu, `--to` is a list
  with the newest migration preselected.
- **`mark --target X`** records the target's next pending migration as
  deployed, without running it. Use it when someone has already made that
  migration's changes on the target by hand. It works on any target, but
  only when the managed schema matches, exactly, a replica built from the
  migrations up to that one. The comparison ignores column order and
  ownership, and separately the deploy role must own the managed schema and
  everything in it (see [Permissions](#permissions)). Each run marks one
  migration.

All four need a person at a terminal. Each shows the target's name, host,
database and last recorded migration, and goes ahead only when you type
`YES` exactly. They refuse in CI (when the `CI` environment variable is set
to anything but `false` or `0`) and without a terminal, and no flag skips
the question.
