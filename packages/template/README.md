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

Nothing else is needed: `super-deploy.config.ts` runs two private
PostgreSQL 18 servers in `.super-deploy` (gitignored), each started whenever
a command needs it. The one in `.super-deploy/dev` holds the local `dev`
target, on a fixed port so you can connect to it (see
[Connecting to dev](#connecting-to-dev)). The one in
`.super-deploy/rehearsal` provides the throwaway databases that rehearsals
use, on a free port, so `dev` is a database on a server of its own like a
real target. `dev` is deployed as the role `deployer`, which owns the `dev`
database and isn't a superuser, like a real target's deploy role (see
[Permissions](#permissions)); each server's superuser `super_deploy` only
sets the server up and runs the rehearsals.

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
[Adding a real target](#adding-a-real-target). To try a draft on `dev`
before finalizing it (`deploy-draft`), or reset `dev` to a migration
(`rebuild`), flag `dev` disposable first: see
[Disposable targets and the guarded commands](#disposable-targets-and-the-guarded-commands).

## Connecting to dev

`dev` is the database `dev` on the server in `.super-deploy/dev`, which
listens on `127.0.0.1` at the `port` set for `devServer` in
`super-deploy.config.ts` (`init` wrote one that was free at the time). With
`port: 54329`:

- `postgres://deployer:deployer@127.0.0.1:54329/dev` is the deploy role,
  which owns the database and everything deployments create in it. Point
  your application at it locally, or look at what a deployment did.
- `postgres://super_deploy:super_deploy@127.0.0.1:54329/dev` is the server's
  superuser, for what a DBA sets up on a real target outside super-deploy
  (see
  [What each target needs set up outside super-deploy](#what-each-target-needs-set-up-outside-super-deploy)):
  your application's roles, external schemas, and the grants on them. Don't
  create anything in the managed schema with it: deployments refuse objects
  the deploy role doesn't own.

The `dev` database exists once a command has used `dev`, such as the first
`deploy --target dev`. The server listens on `127.0.0.1` only, so these
passwords never leave your machine. If another program already listens on
the port, every command that uses `dev` fails naming the port: stop that
program or set another `port`.

The server runs only while something uses it: the first command that needs
`dev` starts it, commands run at the same time share it, and it stops when
the last of them ends. A command that was killed outright (`kill -9`, a
crash, or interrupted twice: see
[Interrupting a command](#interrupting-a-command)) can leave it running; the next command that uses `dev` takes it over
and stops it when it ends. To keep it running while you connect, run this
in the project folder and leave it running; Ctrl+C stops it, unless a
command is still using it:

```sh
node --input-type=module -e 'const { devServer } = await import("./super-deploy.config.ts"); await devServer.start(); console.log("dev is running: Ctrl+C stops it"); const wait = setInterval(() => {}, 60_000); process.once("SIGINT", async () => { clearInterval(wait); await devServer.stop(); })'
```

Commands you run meanwhile use the running server and leave it running.

A project whose `dev` was deployed by an earlier version of super-deploy,
as the server's superuser rather than `deployer`, holds objects the deploy
role doesn't own, so `deploy --target dev` and `status --target dev` refuse
them. `dev` is local, so it is safe to delete and rebuild: with no command
running, delete the `.super-deploy` folder and run `deploy --target dev`
again, which rebuilds it from your migrations (as `deployer`). Data you
added to `dev` by hand is lost with it, and so is its disposable flag (see
[Disposable targets and the guarded commands](#disposable-targets-and-the-guarded-commands)).

`.super-deploy/rehearsal` holds only the throwaway databases rehearsals
use: whenever no command is running, you can delete it, and nothing is
lost. If a crash or reboot leaves a server folder stale or damaged, commands
that need it fail naming what looks wrong. For a `postmaster.pid` that
names a process which isn't its server, delete that file with no command
running. For a folder that isn't a complete PostgreSQL data folder, delete
the folder with no command running: for `.super-deploy/rehearsal` nothing
is lost; for `.super-deploy/dev`, run `deploy --target dev` again, which
loses what you added to `dev` by hand.

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
  `check_option`) and materialized views. A view over a table with
  hand-made policies needs `security_invoker` (see
  [Permissions](#what-each-target-needs-set-up-outside-super-deploy)).
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
  schema), except in routine bodies (next rule). Statements may refer only
  to the managed schema and `pg_catalog`; PL/pgSQL bodies may also refer to
  `externalSchemas`.
- **Routine bodies run with the caller's search path**: PostgreSQL resolves
  the names in a function's or procedure's string body (`as $$ ... $$`, in
  `sql` or `plpgsql`) each time it runs, with the `search_path` of whoever
  calls it. Rehearsals and deployments put the managed schema on it, so
  they pass; but unless the managed schema is `public`, your application's
  roles don't have it on theirs, and every call fails with `relation
  "orders" does not exist`. With `managedSchema: "app"`, write such a
  body one of three ways:
  - qualify the names: `select count(*) from app.orders`;
  - give the routine `set search_path = app, pg_catalog`;
  - for `language sql`, write the body as `begin atomic ... end;`, whose
    names PostgreSQL binds once, at `CREATE`.

  `draft`, `finalize` and `validate` warn about a routine whose string body
  names something the desired schema creates without a schema and that has
  no `SET search_path`, so `validate --strict` fails on it. With
  `managedSchema: "public"`, which every default search path includes, they
  don't. SQL built for `EXECUTE` isn't checked.
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
  The generated config uses a private embedded server of its own
  (`rehearsalServer.rehearsal`). `postgresRehearsal({ env: "REHEARSAL_DATABASE_URL" })`,
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
  super-deploy neither creates them, nor reproduces them in rehearsals, nor
  checks that a target has them: setting them up is the DBA's job (see
  "Permissions", which also says why a migration's scripts can't run
  anything that reads them). Default none.
- `directory`: the folder holding `desired-schema/`, `draft/` and
  `migrations/`, relative to the config file and inside the project.
  Default `data-model`.

Schema names are lowercase PostgreSQL identifiers (letters, digits and `_`),
and none may be a system schema (`pg_...`, `information_schema`).

### Targets

Each entry in `targets` is one target:

- `adapter`: required. How to connect to the target:
  `devServer.target("<database>")` for a database on the private embedded
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

If the CLI dies during a deployment (killed, or its machine lost), the
server rolls the deployment back once it notices the connection is gone.
super-deploy has the server check every 5 seconds while a statement runs
(PostgreSQL's `client_connection_check_interval`; a server on Windows can't,
and runs the statement to its end). Until then the target stays locked:
`deploy` and `status` name the holding attempt, its server process, and the
statement it is running and since when. If you know that command is dead,
`select pg_terminate_backend(<server process>)` ends its session, which rolls
the deployment back and releases the lock. Cancelling only its statement
(`pg_cancel_backend`) isn't enough: the lock belongs to the session.

### Adding a real target

A real target connects to an existing PostgreSQL 18 server with
`postgresTarget`. Import it beside `defineConfig`, and give each target the
name of the environment variable holding its connection string:

```ts
import { defineConfig, postgresTarget } from "super-deploy";

export default defineConfig({
  // ...
  targets: {
    dev: { adapter: devServer.target("dev") },
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

**TLS.** Set `sslmode` in the connection string. super-deploy reads it as
`psql` and libpq do:

- no `sslmode`, `disable` or `allow`: not encrypted. Unlike `psql`, `allow`
  never upgrades to an encrypted connection.
- `require` (or `prefer`): encrypted, but the server's certificate isn't
  checked, so it doesn't stop a server impersonating yours. Unlike `psql`,
  `prefer` never falls back to an unencrypted connection.
- `verify-ca`: encrypted, and the server's certificate must be signed by the
  CA certificate in the file `sslrootcert` names. Without `sslrootcert` the
  connection string is refused.
- `verify-full`: as `verify-ca`, and the certificate must also name the host
  in the connection string. Without `sslrootcert` it trusts the public CAs
  that Node.js ships with.

Any other `sslmode` is refused, as libpq refuses it (the values are
case-sensitive).

For a server with a private CA, such as a managed database's own, download
the CA certificate and use `verify-full` with `sslrootcert`:
`postgresql://deploy_role:password@db.example.com:5432/app?sslmode=verify-full&sslrootcert=/etc/ssl/db-ca.pem`.
A relative `sslrootcert` is read from the directory the command runs in.

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
as already deployed, and it says how many objects (tables, views, sequences,
routines and types) it adopted. An empty managed schema is adopted too, with
a warning that names the target's other schemas holding objects, in case
`managedSchema` was forgotten. If the target has no schema of that name (usually a
typo in `managedSchema`), adoption refuses and writes nothing, listing the
schemas the target has. `managedSchema` must be lowercase: a schema whose
name isn't, such as `"MyApp"`, has to be renamed on the target before it is
adopted (`ALTER SCHEMA "MyApp" RENAME TO myapp`), and the application's
`search_path` and schema-qualified names changed with it. If the
database holds anything super-deploy doesn't support (see
[What the desired schema supports](#what-the-desired-schema-supports)),
nothing is written and every such object is listed: that includes a
`SECURITY DEFINER` routine, objects owned by another role (see
"Permissions"), and views, foreign keys, `LANGUAGE sql` functions and the
like that reference an external schema (only PL/pgSQL bodies may). The
same list says whether the deploy role lacks `CREATE` on the database, and
ends with the `ALTER ... OWNER TO` and `GRANT` statements that fix the
ownership and `CREATE`, as a script to run as a superuser (an object that
must be changed anyway isn't among them). The refusal ends with what to do:
change the target, run those fixes, declare a schema a PL/pgSQL body
references in `externalSchemas`, or run adoption in a terminal to give
override reasons (below). Each object is named as PostgreSQL names it
(`table app.users`), with the references or settings refused.

Columns, defaults, views and other definitions that use another schema's
types or functions (typically an extension installed in `public`, such as
`citext` or `pgcrypto`) are refused, and declaring that schema in
`externalSchemas` doesn't help: only PL/pgSQL bodies may reference it.
Change them on the target first, for example to `text` with a `CHECK`
constraint instead of `citext`, and to the built-in `gen_random_uuid()`
instead of pgcrypto's functions. Grants,
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
example) adoption refuses them, listed apart from anything it doesn't
support, saying to run it in a terminal. `finalize` and `validate` show these
overrides like any other.

### Starting an adoption over

An adoption that went wrong (the wrong `managedSchema` or target, a target
that needed changing first) can be started over, but only while the target
records nothing but the adoption: `status --target <target>` shows
`1 migration recorded`, `00001-adopt`, marked. Adopting again is refused
until then, and both refusals point here.

1. On the target, as the deploy role (it created the history schema, so it
   owns it): `drop schema deployment_history cascade` (or your
   `historySchema`). This also deletes the target's attempt log and its
   disposable flag.
2. In the project, delete `data-model/migrations/` and the `.sql` files
   adoption wrote in `data-model/desired-schema/`.
3. Fix what was wrong, then run `pnpm exec super-deploy init --adopt <target>`
   again.

Never do this on a target that has deployed migrations since it was
adopted: its history is what every later deployment relies on.

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
`SECURITY DEFINER` routines, including inside a function's or procedure's
body. No override marker gets past these refusals, though an overridden
`EXECUTE` runs SQL they never see (see
[Overriding a refusal](#overriding-a-refusal)). Every routine runs as
the role that calls it (`SECURITY INVOKER`, PostgreSQL's default). Each
refusal says what to do instead: run grants, policies and `ALTER DEFAULT
PRIVILEGES` on each target as the deploy role, and create roles there (see
[What each target needs set up outside super-deploy](#what-each-target-needs-set-up-outside-super-deploy)).

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
  role, listing each object with its owner, then the `ALTER ... OWNER TO`
  statements that fix them as a script to run as a superuser (it can be
  pasted into `psql` as it is); `status` lists them under "Deploy would
  refuse". `rebuild` refuses a target whose managed schema itself is owned
  by another role, since `deploy` would refuse the result (what is in the
  schema it drops and creates again, owned by the deploy role). For `public`, which `pg_database_owner` owns, deploy as the
  database's owner: the refusal's fix for it is `ALTER DATABASE <database>
  OWNER TO <deploy role>`, which leaves `public` with `pg_database_owner`.
  The deploy role also needs `CREATE` on the database for
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
  alter default privileges for role deploy_role
    revoke execute on functions from public;
  alter default privileges for role deploy_role in schema app
    grant execute on functions to app_writer;
  ```

  Functions and procedures are callable by `PUBLIC`, every role, unless
  default privileges revoke it. That revoke has to be global, without `in
  schema`: per-schema default privileges can only add privileges, so `in
  schema app revoke execute on functions from public` silently does nothing.

  Default privileges apply only to objects created afterwards: grant on what
  already exists too, e.g. `grant select on all tables in schema app to
  app_reader`.

  A role that refreshes materialized views needs `MAINTAIN` on them, since
  only their owner, the deploy role, can otherwise:

  ```sql
  alter default privileges for role deploy_role in schema app
    grant maintain on tables to app_writer;
  ```

  `MAINTAIN` on tables also allows `VACUUM`, `ANALYZE`, `REINDEX`, `CLUSTER`
  and `LOCK TABLE`, so grant it only to a role that needs it, or by hand on
  each materialized view (`grant maintain on app.order_totals to
  app_writer`).

  Things to know about grants and policies made by hand:

  - A migration that drops and recreates a table (or another object) loses
    the grants, revokes and policies made on it by hand. Default privileges
    grant the new object again; anything else has to be made again after the
    deployment. A lost revoke widens access: a function whose `EXECUTE` was
    revoked from `PUBLIC` by hand is callable by every role again, unless
    default privileges revoke it as above. A function is recreated when its
    arguments or return type change; a change to its body alone keeps its
    privileges. `status`, `deploy` and `deploy-draft` warn about each object
    the pending migrations (or the draft) recreate that has grants, revokes,
    policies or row-level security its default privileges won't give back,
    e.g. `warning: view app.order_totals is recreated by 00007-wider-total:
    its grants of SELECT to app_report will be lost (default privileges
    don't restore them)`. The deployment still goes ahead.
  - A migration that changes the type of, or drops, a column a hand-made
    policy uses fails at deploy: PostgreSQL refuses while the policy depends
    on the column. Rehearsals can't catch it, because their databases have
    no hand-made policies. The deployment rolls back and PostgreSQL's error
    names the policy: drop the policy, deploy, then create it again.
  - The deploy role owns every object, and row-level security doesn't apply
    to a table's owner. A view reads its tables as its owner, so it shows
    every row of a table whose policies hide them, unless it is created
    `with (security_invoker = true)`, which makes it read them as the role
    querying it. Declare views over tables that get policies that way:

    ```sql
    create view my_orders with (security_invoker = true) as
      select id, total from orders;
    ```

    A materialized view is built and refreshed as the deploy role, so it
    holds every row whatever the policies on its tables: don't build one
    over rows a policy must hide.
  - With `FORCE ROW LEVEL SECURITY`, a table's policies apply to its owner
    too, so they would hide rows from a deployment's own scripts and from
    the materialized views it builds. Deployments run with `row_security`
    off, as `pg_dump` does: a statement a policy would filter fails with
    `query would be affected by row-level security policy for table
    "orders"` instead of silently skipping rows, and the deployment rolls
    back.
    Rehearsals can't catch it. Run `ALTER TABLE orders NO FORCE ROW LEVEL
    SECURITY` while deploying and `FORCE` it again afterwards, or move the
    work out of the migration.
- **External schemas** (`externalSchemas` in `super-deploy.config.ts`, see
  [Project settings](#project-settings)), and grants on them and their
  objects. super-deploy doesn't check them: `deploy` goes ahead on a target
  without them, and a routine that reads a missing one fails only when it
  runs. On `dev`, create them as the superuser (see
  [Connecting to dev](#connecting-to-dev)). Routines run as their caller, so it's the application's
  roles that need these grants. For example, a
  PL/pgSQL function `app_writer` calls that reads `auth.users` needs:

  ```sql
  grant usage on schema auth to app_writer;
  grant select on auth.users to app_writer;
  ```

  Rehearsals have no `auth` schema, so only PL/pgSQL bodies may reference
  it, and a migration's scripts and seed data can't fire a trigger (or call
  anything else) that reads it: every rehearsal of the migration would fail
  with `relation "auth.users" does not exist`, whatever the targets have.
  Such a trigger also blocks every later migration whose scripts write to
  its table.

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
   `draft` runs it once after the migrations, seed data and pre-migration
   script, and warns when PostgreSQL refuses it or it doesn't produce the
   desired schema, naming the cause: such a change has to be made by hand
   in the pre-migration script (for example
   [Reordering a composite type's attributes](#reordering-a-composite-types-attributes)).
3. `post-migration.sql` (optional, hand-written): runs after the schema
   change, and may only change data, such as backfilling a new column.

`seed-data.sql` (optional) is loaded only by the draft's own rehearsals,
just before the pre-migration script (see [Seed data](#seed-data)). It is
never run by a deployment.

No other file in a draft or migration is run. `draft.json` holds the draft's
name, and hashes of the desired schema and the schema change `draft`
generated, so `rehearse` can tell whether running `draft` again would help.
`schema-change.generated.sql` is a copy of the schema change as `draft`
generated it. If you edit `schema-change.sql` anyway, `rehearse` and
`finalize` warn that it was edited by hand, and `deploy-draft` says so before
asking for YES. `finalize` records the edit in the migration's
`metadata.json` and writes `HAND-EDITED.md` into the migration, with the diff
from the generated schema change to yours, so reviewers see it; `validate`
lists such migrations as a notice, which `--strict` doesn't fail on.
`draft`, `rehearse`, `finalize` and `validate` warn about any other file in
the draft folder, such as a misnamed `post-migrate.sql`, naming it and the
files a draft holds; `finalize` still copies it into the migration.

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
migration, so work in progress can't be merged. (`validate` changes
nothing, so `pnpm exec` is fine there; for `deploy` in CI, see
[Interrupting a command](#interrupting-a-command).)

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
  execute format('insert into app.staging select * from %I', source);
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
- An overridden `EXECUTE` runs SQL the rules never see, privilege
  statements included: a trigger fired by a deployment's script runs it as
  the deploy role. Reviewers must read what it builds.
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

## Reordering a composite type's attributes

`draft` can't reorder a composite type's attributes, or add one anywhere
but at the end: it generates nothing for them, and warns. Make the change in
`data-model/draft/pre-migration.sql`: create the type in its new order,
convert every column that uses it, drop the old type and rename the new
one. Then run `draft` again. For example, to swap `money_amount`'s two
attributes:

```sql
create type money_amount_new as (amount numeric(12,2), currency char(3));
alter table orders alter column price type money_amount_new
  using case when price is null then null
    else row((price).amount, (price).currency)::money_amount_new end;
drop type money_amount;
alter type money_amount_new rename to money_amount;
```

Dropping the old type is destructive, so `finalize` asks you to acknowledge
it.

## Changing the type of a column a generated column uses

PostgreSQL refuses to change the type of a column that a stored generated
column uses, and `draft` generates the type change without touching the
generated column, so `draft` warns and the rehearsal fails with
`cannot alter type of a column used by a generated column`. Drop the
generated column in `data-model/draft/pre-migration.sql` and run `draft`
again: the schema change then changes the type and adds the generated
column back, which computes it again for every row. For example, for
`total numeric generated always as (price * qty) stored`:

```sql
alter table a drop column total;
```

Dropping a column is destructive, so `finalize` asks you to acknowledge it.

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
decimal places, such as `numeric(6,2)` to `numeric(5,1)`. The deployment
doesn't fail. A `numeric` that also allows fewer digits before the decimal
point, such as `numeric(6,2)` to `numeric(4,1)`, rounds the same way, but a
value too large for it fails the deployment. `draft` says how many values in
the rehearsal data don't fit (for such a `numeric`, how many are rounded and
how many are too large, which makes the rehearsal fail too), and `finalize`
asks for the change to be acknowledged. If those values matter, shorten or
move them in the pre-migration script.

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

A deployment can also refuse before it runs anything, because the target
has drifted: see [Drift](#drift).

## Drift

A target has drifted when its managed schema differs from a replica that
super-deploy builds, in a throwaway database, from the migrations the target
records: a table, column, index or other object made, dropped or changed on
the target by hand. `deploy` checks for drift before it changes anything
and refuses a drifted target, naming what differs. `status --target X`
lists each difference, saying which side it is on, and exits 1 on drift.
Every difference counts, even an object a pending migration would create
exactly as it is.

Not compared, so never drift:

- grants, default privileges, policies and row-level security, which are set
  up on each target outside super-deploy (see [Permissions](#permissions));
- ownership: the deploy pre-flight checks it separately, and `deploy` and
  `status` name objects the deploy role doesn't own;
- column order (except a composite type's attributes, whose order is part of
  the type).

`status` says `Drift: none` when it checked and found none, and
`Drift: not checked (...)`, exiting 1, when it couldn't check: the target
holds a deployed draft (`rebuild` resets it), its recorded history doesn't
match the project's migrations, or another command holds the target's lock.

To get a drifted target deploying again, make it match its recorded
migrations, in one of these ways:

- **Undo it.** Reverse the change on the target by hand, as the deploy role,
  until `status --target X` shows `Drift: none`.
- **Keep it.** Make the desired schema describe the target as it now is
  (add what was added, remove what was dropped, change what changed), then
  `draft` and `finalize` a migration, and run `mark --target X`. `mark`
  records that migration as deployed on the drifted target without running
  it, once the target matches a replica of the migrations up to it (see
  [Disposable targets and the guarded commands](#disposable-targets-and-the-guarded-commands)).
  Other targets deploy the migration normally. If a pending migration
  already makes the change that was made by hand, `mark` it the same way.
- **Rebuild it.** On a disposable target, `rebuild --target X --to N` drops
  everything in the managed schema and replays migrations 1 to N, losing
  the target's data in it.

## Interrupting a command

Ctrl+C (SIGINT), SIGTERM, or closing the terminal (SIGHUP) stops the
running command. It cleans up first, then exits 130, 143 or 129: a
deployment in progress rolls back and its attempt is recorded as abandoned,
throwaway databases are dropped, and the embedded servers the command
started are stopped. It prints one line when the interruption arrives. A
command that changes a target (`deploy`, `deploy-draft`, `rebuild`,
`mark`, `disposable`, `init --adopt`) prints one more once it has cleaned
up, saying what happened to the target:

- `The deployment rolled back: target qa is unchanged, still at migration 00009-add-tier.`
- `The deployment had already finished: the interruption came too late to stop it on target qa.`
  when the interruption came after its COMMIT. It still exits 130, 143 or
  129, and `status --target qa` shows the attempt succeeded.

An interruption after the command has finished, while it stops its
servers, doesn't change its exit code: a deployment that committed exits 0.

**In CI or under a supervisor** (a CI runner cancelling a step, `docker
stop`, systemd), run the binary directly, as
`./node_modules/.bin/super-deploy deploy --target prod`, or make sure the
stop signal reaches the whole process group. With pnpm installed through
corepack, SIGTERM to `pnpm exec super-deploy ...` alone stops only pnpm's
launcher: the job ends with 143 while the deployment carries on unseen and
commits. After a cancelled job, `status --target prod` shows whether the
attempt was abandoned or succeeded.

Interrupting again while it cleans up exits at once, leaving whatever
wasn't cleaned up yet (the next command takes over a server left running).
The same signal again within a second doesn't count: in a terminal,
`pnpm exec` passes on a SIGTERM or SIGHUP the command has already had. Nor
does a second SIGHUP: no one is left at the terminal to insist.

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

If a finalized migration (or Recovery) was edited, had a file added, or had
its `desired-schema/` snapshot changed, `validate`, `status` and `deploy`
refuse it as `changed after it was finalized`. Restore its folder from Git
(`git checkout HEAD -- data-model/migrations/00002-add-orders`, and delete
any file you added to it), then run `pnpm exec super-deploy validate`, which
makes it read-only again. To change what the migration does, finalize a new
migration, or a Recovery for the targets where it failed.

## Disposable targets and the guarded commands

A disposable target is one flagged as safe to wipe and experiment on, with
`disposable --target X --set yes`. Every target starts not disposable, `dev`
included, so `deploy-draft` and `rebuild` refuse it until it is flagged.
Before the first `deploy-draft` or `rebuild` on `dev`, flag it once:

```sh
pnpm exec super-deploy disposable --target dev --set yes
```

and type `YES`. The flag lives in the target's database, so a database
rebuilt outside super-deploy starts unflagged again: deleting
`.super-deploy` to rebuild `dev` loses it, and `dev` needs flagging again.
(`rebuild` keeps it.) `status` shows a flagged target as `(disposable)`.

Four commands change a target outside the normal draft-finalize-deploy
path:

- **`disposable --target X --set yes|no`** flags target `X` as disposable,
  or not. The flag lives in the target itself, in its history schema
  (`deployment_history` by default), not in `super-deploy.config.ts`, so no
  config change can make production disposable. Before you type `YES` to
  mark it disposable, it shows how many tables the managed schema holds
  and about how many rows (PostgreSQL's estimate), so a database full of
  real data stands out. Marking a target that holds a deployed draft not
  disposable warns that `deploy` refuses it until `rebuild` resets it, which
  then needs it flagged disposable again; `status` and `deploy` say so too.
- **`deploy-draft --target X`** tries the current, unfinalized draft on a
  disposable target, so its scripts meet the target's data before you
  finalize. The target must have no pending migrations (a Recovery draft of
  migration N needs the target at N-1). The draft's pre-migration script,
  schema change and post-migration script run in one transaction, without a
  rehearsal first. Before asking for YES it refuses a draft generated from
  an older desired schema (run `draft` again), and its confirmation says so
  when `schema-change.sql` was edited by hand since `draft` generated it.
  `--with-seed` loads the draft's seed data first, which
  may clash with data already on the target. The target then records that
  it holds the draft, not a migration: `deploy`, `mark` and another
  `deploy-draft` refuse it, and `status` doesn't check it for drift, until
  `rebuild` resets it.
- **`rebuild --target X --to N`** resets a disposable target to migration
  N, in one transaction. N may be 0: it then replays no migrations, which
  resets a target holding a draft deployed before any migration (a first
  draft, or a Recovery draft of migration 1) so you can try it again. It drops everything in the managed schema, with
  `CASCADE`. The confirmation lists what in the managed schema no recorded
  migration created (what `status` reports as only on the target, from a
  throwaway replica of the recorded migrations), up to 10 objects. Objects
  in other schemas that depend on the managed schema are dropped too:
  a view on a managed table, a foreign key to one, a column of a managed
  type, a table inheriting from a managed table or typed with a managed
  composite type (those two with their data). The confirmation lists each of them under "Also
  drops, outside schema ...", and if that list changes while it waits for
  `YES`, rebuild refuses without changing anything. It refuses before
  asking when the managed schema holds something the deploy role can't
  drop, such as an extension a superuser installed or a member of an
  extension installed in another schema, naming each object and its owner.
  PostgreSQL can't give an extension another owner, so have its owner or a
  superuser drop it (`DROP EXTENSION ... CASCADE`). The managed schema itself stays, with its owner, grants and
  default privileges. Then it deletes the target's record of migrations and of any
  deployed draft, and runs migrations 1 to N as a deployment does, each as
  its newest Recovery if it has one; the confirmation and the result name
  it, as in `00002-require-city (Recovery 1)`. It never loads seed data, and keeps
  the attempt log and the disposable flag. In the menu, `--to` is a list
  with the newest migration preselected and "no migrations" (0) below
  migration 1.
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
`YES` exactly. The host is the one in the connection string, followed by the
address the server reports when that differs, e.g.
`db.prod.internal:5432 (10.0.4.7:5432)`. They refuse in CI (when the `CI` environment variable is set
to anything but `false` or `0`) and without a terminal, and no flag skips
the question.
