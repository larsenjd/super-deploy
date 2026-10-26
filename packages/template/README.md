# PostgreSQL schema

This project manages a PostgreSQL 18 schema with [super-deploy](https://github.com/larsenjd/super-deploy). You edit the schema you want, and super-deploy generates migrations from it. Each migration is frozen once finalized and deploys all-or-nothing.

## Index

| | Sections |
| --- | --- |
| 🚀 **Start** | [How it works](#how-it-works) · [Getting started](#getting-started) ([inside another Git repo](#a-project-inside-another-git-repository)) · [Commands](#commands) · [Connecting to dev](#connecting-to-dev) |
| ✏️ **Write** | [What the desired schema supports](#what-the-desired-schema-supports) ([supported](#supported) · [refused](#refused) · [rules](#rules-for-writing-it)) · [Draft and migration files](#the-files-of-a-draft-and-a-migration) |
| ⚙️ **Configure** | [Configuration](#configuration) ([project settings](#project-settings) · [targets](#targets) · [adding a real target](#adding-a-real-target)) · [Permissions](#permissions) ([per-target setup](#what-each-target-needs-set-up-outside-super-deploy)) |
| 📥 **Adopt** | [Adopting an existing database](#adopting-an-existing-database) ([from older PostgreSQL](#adopting-from-an-older-postgresql) · [starting over](#starting-an-adoption-over)) |
| 🧪 **[Recipes](#recipes)** | [Renaming a column](#renaming-a-column) · [Reordering a composite type](#reordering-a-composite-types-attributes) · [Retyping a generated column's source](#changing-the-type-of-a-column-a-generated-column-uses) · [Column order](#column-order) · [Seed data](#seed-data) · [Destructive changes](#destructive-changes) · [Overriding a refusal](#overriding-a-refusal) |
| 🩹 **Fix** | [When a deploy fails](#when-a-deploy-fails) · [Drift](#drift) · [Changing your mind](#changing-your-mind) · [Disposable targets](#disposable-targets-and-the-guarded-commands) · [Interrupting a command](#interrupting-a-command) |

## How it works

```mermaid
flowchart LR
  DS["desired-schema/*.sql<br>edited by hand"] -->|draft| D["draft/<br>generated schema change<br>+ your scripts"]
  D -->|rehearse| R{"replays on a<br>throwaway database<br>and matches?"}
  R -->|no| DS
  R -->|yes| F["finalize"]
  F --> M["migrations/00001-…<br>read-only, hashed"]
  M -->|deploy| T[("target<br>dev · qa · prod")]
```

| Term | Meaning |
| --- | --- |
| **Desired schema** | `CREATE` statements under `data-model/desired-schema/` that describe the schema you want. |
| **Draft** | The next migration, still editable, in `data-model/draft/`. |
| **Migration** | A numbered, finalized step. It never changes after it is finalized. |
| **Schema change** | The generated part of a migration (`schema-change.sql`). Never edit it. |
| **Pre-/post-migration script** | Hand-written SQL that runs before or after the schema change. |
| **Rehearsal** | Replaying migrations on a throwaway database to prove that they produce the desired schema. |
| **Target** | A named database that receives deployments, such as `dev`, `qa` or `prod`. |
| **Deployment** | Applying every pending migration to a target in **one transaction**. |
| **Managed schema** | The one schema super-deploy owns on each target (default `public`). |
| **History schema** | Records what each target has run (default `deployment_history`). |
| **Deploy role** | The database user super-deploy connects as. It owns everything in the managed schema. |
| **Drift** | A hand-made difference between a target and what its recorded migrations built. |
| **Recovery** | Replacement scripts for a failed migration, for targets that haven't run it yet. |
| **Seed data** | Synthetic rows that reproduce a target's problem data in the draft's rehearsals. |
| **Disposable target** | A target flagged as safe to wipe, such as `dev`. |

## Getting started

```sh
git init        # first, so pnpm install can install the pre-commit hook
pnpm install
```

```mermaid
flowchart LR
  A["1 · Write CREATE statements<br>in data-model/desired-schema/"] --> B["2 · super-deploy draft<br>--name 'add customers'"]
  B --> C["3 · super-deploy finalize"]
  C --> E["4 · super-deploy deploy<br>--target dev"]
```

Prefix each command with `pnpm exec`. Run `pnpm exec super-deploy` on its own for an interactive menu, or add `--help` to see every command.

No database is needed. `super-deploy.config.ts` runs two private PostgreSQL 18 servers. Each one starts when a command needs it and stops when the command ends.

| Server | Holds | Port |
| --- | --- | --- |
| `.super-deploy/dev` | The `dev` target, deployed as the non-superuser `deployer` | Fixed, so you can [connect](#connecting-to-dev) |
| `.super-deploy/rehearsal` | Throwaway databases for rehearsals | Any free port |

The pre-commit hook (Husky) runs `pnpm precommit` on every commit. If you ran `pnpm install` before `git init`, run it again.

### A project inside another Git repository

Husky installs the hook only when the project folder is the repository root. For a project in a subfolder, such as `db/`, use one of these:

- **Husky from the project.** In `package.json`, set `"prepare": "cd .. && husky db/.husky"` (one `..` per folder level). Then start `.husky/pre-commit` with `cd db`, followed by `pnpm precommit`.
- **The repository already has hooks** (Husky, lefthook, `core.hooksPath`). Add `pnpm --dir db precommit` to its pre-commit hook. Then delete the project's `prepare` script and its `.husky/` folder.

## Commands

| Stage | Command | What it does |
| --- | --- | --- |
| Author | `draft --name <n>` | Generates the schema change, from the newest migration to the desired schema. |
| | `rehearse` | Replays every migration plus the draft and checks the result matches the desired schema. |
| | `finalize` | Rehearses the draft, then freezes it as the next migration. |
| | `validate [--strict]` | Checks hashes and the chain of migrations, and warns about unfinished work. |
| | `unfinalize` · `restore-schema` · `discard-draft` | Undo work: see [Changing your mind](#changing-your-mind). |
| Deploy | `deploy --target <t>` | Rehearses, then applies every pending migration in one transaction. |
| | `status --target <t>` | Shows pending migrations, recent attempts and drift. Exits 1 on problems. |
| Recover | `recovery --migration <n>` | Starts a [Recovery](#when-a-deploy-fails) draft. |
| | `mark --target <t>` | Records the next migration as deployed without running it. |
| Disposable | `disposable` · `deploy-draft` · `rebuild` | See [Disposable targets](#disposable-targets-and-the-guarded-commands). |

## Connecting to dev

With `port: 54329` set for `devServer` in `super-deploy.config.ts`:

| URL | Use |
| --- | --- |
| `postgres://deployer:deployer@127.0.0.1:54329/dev` | The deploy role. Point your app here. |
| `postgres://super_deploy:super_deploy@127.0.0.1:54329/dev` | The superuser, for DBA setup such as app roles, external schemas and grants. Don't create objects in the managed schema with it. |

- The `dev` database exists after the first command that uses it, such as `deploy --target dev`.
- The server listens on `127.0.0.1` only, so these passwords never leave your machine.
- The server runs only while a command uses it. To keep it running while you connect, run this command and press Ctrl+C to stop it:

  ```sh
  node --input-type=module -e 'const { devServer } = await import("./super-deploy.config.ts"); await devServer.start(); console.log("dev is running: Ctrl+C stops it"); const wait = setInterval(() => {}, 60_000); process.once("SIGINT", async () => { clearInterval(wait); await devServer.stop(); })'
  ```

> [!TIP]
> **Something wrong with a local server?** Delete its folder while no command is running.
>
> - `.super-deploy/rehearsal`: nothing is lost.
> - `.super-deploy/dev`: run `deploy --target dev` to rebuild it. Data you added by hand and the disposable flag are lost.
>
> If an error names a stale `postmaster.pid`, deleting that one file is enough. If `dev` was deployed by an older super-deploy as the superuser, delete `.super-deploy/` and rebuild it the same way.

## What the desired schema supports

Refused statements are listed as `<file>:<line>: <reason> [<rule>]`. "Not supported in V1" means not yet supported.

### Supported

- **Tables:** identity columns, defaults, stored generated columns, collations, and all constraint kinds, deferrable or not.
- **`ALTER TABLE … ADD CONSTRAINT`**, with one constraint per statement.
- **Indexes:** unique, partial and expression indexes, with any method and storage parameters.
- **Views** (`security_invoker`, `security_barrier`, `check_option`) and **materialized views**.
- **Functions and procedures** in `sql` or `plpgsql`, and **triggers**.
- **Domains** and **composite types**.
- **`COMMENT ON`** any of the above, except view columns.
- `CREATE EXTENSION plpgsql`.

### Refused

| Refused | Use instead |
| --- | --- |
| Enums | A lookup table with a foreign key, or a `CHECK` constraint |
| Extensions other than `plpgsql`, such as `pgcrypto` | Built-ins, such as `gen_random_uuid()` and `uuidv7()` |
| Standalone sequences and `serial` columns (`bigserial`, `smallserial`, `serial8`, …) | `bigint generated always as identity` |
| Partitioned tables and partitions (`PARTITION OF`) | — |
| Virtual generated columns | Add `STORED` |
| Range types and base types | A domain or a composite type |
| Comments on view and materialized-view columns | The view's own comment |
| Grants, roles, ownership, policies, row-level security, `SECURITY DEFINER` | Set them up on the target: see [Permissions](#permissions) |

<details>
<summary>The full list of refused objects</summary>

- Rules (`CREATE RULE`), event triggers, foreign tables, foreign data wrappers, servers, user mappings, publications and subscriptions
- Custom casts, operators, operator classes, operator families, aggregates, collations, conversions, transforms and access methods
- Text-search configurations, dictionaries, parsers and templates
- Procedural languages, and functions in any language but `sql` and `plpgsql`
- `CREATE STATISTICS`
- Table inheritance (`INHERITS`), typed tables (`CREATE TABLE ... OF type`), temporary tables and temporary views
- `NOT ENFORCED` constraints and constraint triggers
- Routine options other than `LANGUAGE`, volatility, `STRICT`, `LEAKPROOF`, `PARALLEL`, `COST`, `ROWS` and `SET`, such as `WINDOW` and `SUPPORT`
- View options other than the three above
- Unlogged tables, tablespaces, table and materialized view storage parameters, table access methods (`USING heap`), and column `STORAGE` and `COMPRESSION` settings

</details>

### Rules for writing it

| Rule | Why |
| --- | --- |
| **Name every index and constraint**, except primary keys and `NOT NULL` constraints | Otherwise PostgreSQL picks names that depend on load order |
| **Define each object once** (`IF NOT EXISTS` and `OR REPLACE` are fine) | No definition can silently replace another |
| **No `CREATE SCHEMA`**: refer only to the managed schema and `pg_catalog` | super-deploy creates the one managed schema |
| **Among `ALTER` statements, only `ALTER TABLE … ADD CONSTRAINT`**, and no `LIKE` | Declare everything else in `CREATE TABLE` |
| **No `INSERT`, `UPDATE`, `DELETE`, `DO` or `SET`** | Data changes belong in a draft's scripts |
| **No `CREATE INDEX CONCURRENTLY`** | It can't run inside a transaction |
| **No `EXECUTE` or transaction-escaping built-ins** such as `pg_notify` | Unless an [override marker](#overriding-a-refusal) gives a reason |

> [!IMPORTANT]
> **Routine bodies resolve names with the caller's `search_path`.** If `managedSchema` isn't `public`, your app's calls fail with `relation "orders" does not exist`. Fix it in one of three ways:
>
> - qualify the names: `app.orders`;
> - add `set search_path = app, pg_catalog` to the routine;
> - for `language sql`, write the body as `begin atomic … end`.
>
> `validate --strict` fails on routines that do none of these.

## The files of a draft and a migration

A deployment runs these files in one transaction, in this order:

```mermaid
flowchart LR
  P["pre-migration.sql<br><i>optional, hand-written</i><br>data and structure"] --> S["schema-change.sql<br><i>generated, never edit</i>"] --> Q["post-migration.sql<br><i>optional, hand-written</i><br>data only"]
```

| File | Purpose |
| --- | --- |
| `seed-data.sql` | Loaded only in the draft's own rehearsals, before the pre-migration script. Never deployed. |
| `draft.json` | The draft's name and hashes. |
| `schema-change.generated.sql` | A copy of what `draft` generated. If you edit `schema-change.sql`, `finalize` records the edit and writes `HAND-EDITED.md`. |
| `metadata.json` | Tool versions, acknowledged destructive statements and overrides. Finalized migrations only. |
| `desired-schema.diff` | This migration's change to the desired schema, in `git diff` format, so pull requests show it. Finalized migrations only. |
| `recoveries/recovery-K/` | [Recoveries](#when-a-deploy-fails) of this migration. |

`finalize` refuses any other file in the draft folder (`unknown-draft-file`). Finalized files are written with LF line endings, and hashes ignore line endings.

> [!WARNING]
> **Finalized migrations are read-only and hashed.** Never edit them. `validate` catches edits, and the pre-commit hook runs `validate --strict --allow-draft`.
>
> In CI, run `validate --strict` without `--allow-draft`, so an unfinalized draft can't be merged.

## Configuration

`super-deploy.config.ts` exports `defineConfig({ … })`. super-deploy refuses unknown settings.

### Project settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `postgresVersion` | *required* | Must be `18`. Another version is allowed only for [adopting from an older PostgreSQL](#adopting-from-an-older-postgresql). |
| `rehearsal` | *required* | Where throwaway databases come from. Use `postgresRehearsal({ env: "REHEARSAL_DATABASE_URL" })` for an existing server whose login has `CREATEDB`. |
| `targets` | none | The named targets: see [Targets](#targets). Names may use letters, digits, `-` and `_`. |
| `managedSchema` | `public` | The one schema that super-deploy manages. |
| `historySchema` | `deployment_history` | Records migrations, attempts and the disposable flag. Must differ from `managedSchema`. |
| `externalSchemas` | none | Schemas that PL/pgSQL bodies may read, such as `["auth"]`. The DBA sets them up; super-deploy doesn't check them. |
| `directory` | `data-model` | Holds `desired-schema/`, `draft/` and `migrations/`. |

Schema names are lowercase identifiers, and can't be system schemas.

### Targets

| Setting | Default | Meaning |
| --- | --- | --- |
| `adapter` | *required* | `devServer.target("<db>")` for the local server, or `postgresTarget(…)` for a real server. |
| `lockTimeout` | `"5s"` | How long a statement waits for a lock before the deployment rolls back. |
| `statementTimeout` | none | The maximum run time for one statement. |
| `connectTimeout` | `"10s"` | How long connecting may take. |

Durations are milliseconds (`500`) or strings with a unit: `"500ms"`, `"5s"`, `"2min"` or `"1h"`.

<details>
<summary>If the CLI dies mid-deployment</summary>

The server rolls the deployment back once the session ends. super-deploy sets up each session so that this happens quickly:

- The server checks every 5 seconds whether the client is still there (not on Windows servers).
- A session left idle inside its transaction ends after one minute.
- TCP keepalives detect a vanished machine within about a minute.

Until then, the target stays locked, and `status` names the process that holds the lock. To release it, run `select pg_terminate_backend(<pid>)`. `pg_cancel_backend` isn't enough, because the lock belongs to the session.

If a deployment waits on another session's lock, `status` shows `waiting for a lock held by server process N`.

</details>

### Adding a real target

```ts
import { defineConfig, postgresTarget } from "superdeploy";

export default defineConfig({
  // ...
  targets: {
    dev: { adapter: devServer.target("dev") },
    qa: { adapter: postgresTarget({ env: "QA_DATABASE_URL" }) },
    prod: { adapter: postgresTarget({ env: "PROD_DATABASE_URL" }), lockTimeout: "2s" },
  },
});
```

- The variable is read only when a command uses that target. If it is unset, the command fails before connecting.
- `postgresTarget({ connectionString })` also works, but the config is committed, so keep passwords out of it.
- **The deploy role is the user in the connection string.**

**TLS:** set `sslmode` in the connection string.

| `sslmode` | Encrypted | Certificate checked |
| --- | --- | --- |
| none, `disable`, `allow` | no | — |
| `require`, `prefer` | yes, with no fallback | no |
| `verify-ca` | yes | against `sslrootcert`, which is required |
| `verify-full` | yes | CA and host name, against `sslrootcert` or else Node's public CAs |

For a managed database with a private CA, use `?sslmode=verify-full&sslrootcert=/path/to/ca.pem`.

## Adopting an existing database

```mermaid
flowchart TD
  A["Add the database as a target<br>and set managedSchema"] --> B["init --adopt target"]
  B --> C{"anything<br>refused?"}
  C -->|yes| D["Fix it on the target,<br>for example by running the printed<br>OWNER TO / GRANT script"] --> B
  C -->|EXECUTE / pg_notify| E["Run in a terminal and<br>give a reason for each override"] --> B
  C -->|no| F["desired-schema/ + 00001-adopt,<br>recorded as deployed on the target"]
```

- Adopt before any draft or migration exists.
- Adoption writes nothing while anything is refused. It lists every unsupported object, objects owned by another role, and a missing `CREATE` privilege. It ends with a fix script to run as a superuser.
- Columns, defaults or `sql` functions that use another schema's types or functions are refused, even if that schema is listed in `externalSchemas`. A common case is `citext` or `pgcrypto` installed in `public`. Change them first, for example to `text` with a `CHECK` constraint, or to the built-in `gen_random_uuid()`.
- Grants, policies and row-level security stay on the target and are left out of the desired schema. New targets don't get them.
- A schema whose name isn't lowercase must be renamed first: `ALTER SCHEMA "MyApp" RENAME TO myapp`.

### Adopting from an older PostgreSQL

1. Set `postgresVersion` to the old version, such as `16`, and run `init --adopt <target>`.
2. Set `postgresVersion` back to `18`, and deploy to PostgreSQL 18 targets.

Rehearsals always run on 18. Deploying to the old server isn't supported.

### Starting an adoption over

This works only while `status --target <t>` shows a single recorded migration, `00001-adopt`:

1. On the target, as the deploy role, run `drop schema deployment_history cascade`. This also deletes the attempt log and the disposable flag.
2. Delete `data-model/migrations/` and the files that adoption wrote in `desired-schema/`.
3. Fix what went wrong, then run `init --adopt <target>` again.

> [!CAUTION]
> Never do this on a target that has deployed migrations since adoption.

## Permissions

super-deploy knows one role: the **deploy role**. It owns the managed schema and everything in it. Everything else about access is set up **on each target, outside super-deploy**.

```mermaid
flowchart LR
  DR["deploy role"] -->|"owns: deployments<br>create everything"| O[("managed schema<br>objects")]
  AR["app roles<br><i>you create</i>"] -->|"grants, default privileges<br><i>you set up</i>"| O
  P["policies, RLS<br><i>you set up</i>"] -.-> O
```

- **Refused everywhere** (desired schema, scripts and seed data): grants, revokes, `ALTER DEFAULT PRIVILEGES`, roles, `OWNER TO`, policies, enabling or disabling RLS, and `SECURITY DEFINER`. No override marker gets past these.
- **Never compared:** grants, policies and RLS are not drift, and `deploy` leaves them alone.

### What each target needs set up outside super-deploy

| What | How |
| --- | --- |
| **The deploy role** | It owns, or inherits from the owner of, the managed schema and everything in it, and needs `CREATE` on the database for the first deployment. Otherwise a DBA pre-creates both schemas: `create schema deployment_history authorization deploy_role`. For `public`, make the deploy role the database owner. |
| **App roles** | Create them and grant `CONNECT`. super-deploy never creates roles. |
| **Grants** | Use default privileges, so new objects are granted automatically (see below). |
| **External schemas** | Create them and grant your app roles access. On `dev`, use the superuser URL. |

Run these grants once per target, as the deploy role:

```sql
grant usage on schema app to app_reader, app_writer;
alter default privileges for role deploy_role in schema app grant select on tables to app_reader;
alter default privileges for role deploy_role in schema app grant select, insert, update, delete on tables to app_writer;
alter default privileges for role deploy_role revoke execute on functions from public;  -- global: no "in schema"
alter default privileges for role deploy_role in schema app grant execute on functions to app_writer;
grant select on all tables in schema app to app_reader;  -- default privileges skip existing objects
```

> [!WARNING]
> **Rehearsals can't see what you set up by hand.** These pass rehearsal and then fail, or lose access, at deploy:
>
> - **A recreated object loses its hand-made grants, revokes and policies.** `status` and `deploy` warn about each one.
> - **Changing or dropping a column that a policy uses fails.** Drop the policy, deploy, then recreate it.
> - **Changing something that another schema depends on fails**, such as a view or foreign key in another schema. Drop the dependent object, deploy, then recreate it.
> - **`FORCE ROW LEVEL SECURITY` makes scripts fail.** Deployments run with `row_security` off. Turn it to `NO FORCE` while deploying.
> - **A trigger that reads an external schema** fails every rehearsal of a script that fires it.

The deploy role owns every table, so RLS doesn't apply to it. Create views over tables with policies `with (security_invoker = true)`, and don't build materialized views over hidden rows. To refresh a materialized view, a role needs `MAINTAIN` on it.

## Recipes

### Renaming a column

`draft` sees a rename as a drop plus an add. Do the rename in `draft/pre-migration.sql`, then run `draft` again. For a `NOT NULL` column, rename its constraint too, because PostgreSQL 18 keeps the old constraint name:

```sql
alter table t rename column old to new;
alter table t rename constraint t_old_not_null to t_new_not_null;
```

### Reordering a composite type's attributes

`draft` can't reorder a composite type's attributes, or insert one anywhere but at the end. Do it in the pre-migration script, then run `draft` again:

```sql
create type money_amount_new as (amount numeric(12,2), currency char(3));
alter table orders alter column price type money_amount_new
  using case when price is null then null
    else row((price).amount, (price).currency)::money_amount_new end;
drop type money_amount;
alter type money_amount_new rename to money_amount;
```

### Changing the type of a column a generated column uses

PostgreSQL refuses this while a generated column depends on the column. Drop the generated column in the pre-migration script (`alter table a drop column total;`), then run `draft` again. The schema change retypes the column and re-adds the generated column.

### Column order

Column order is never compared. Columns added later go at the end, and so can columns of a type or function created in the same migration. As a result, targets can differ. Scripts and seed data refuse SQL that depends on column position: `INSERT` without a column list, `SELECT *`, `ORDER BY 1`, `NATURAL JOIN` and whole-row references.

### Seed data

`draft/seed-data.sql` holds `INSERT` statements, with column lists, that reproduce a target's problem rows. The draft's rehearsals load it before the pre-migration script. It is never deployed. Only `deploy-draft --with-seed` loads it, and only onto a disposable target.

> [!CAUTION]
> Seed data is committed forever. Make it synthetic, and never copy production data into it.

### Destructive changes

A statement is **destructive** if it drops structure or deletes data:

- `DROP`, and dropping a column, attribute or constraint;
- changing a column's type, unless it is a known widening such as `integer` to `bigint`;
- `DELETE` and `TRUNCATE`.

Dropping and recreating a view, index, function or constraint in the same migration doesn't count.

`finalize` asks you to acknowledge destructive statements. In CI, pass `--acknowledge-destructive` after reviewing them. They are recorded in `metadata.json`.

| Change | Danger | Do instead, in the pre-migration script |
| --- | --- | --- |
| Narrowing, such as `text` to `varchar(5)` or `numeric(6,2)` to `numeric(5,1)` | Values are **silently cut or rounded** | Fix the values first |
| A column's collation | The column is dropped, **losing its values** | `ALTER COLUMN c TYPE text COLLATE "C"` |
| A generation expression | The column is dropped and recomputed | `ALTER COLUMN c SET EXPRESSION AS (…)` |

### Overriding a refusal

Two refusals can be overridden: `EXECUTE` (`[plpgsql-dynamic-sql]`) and transaction-escaping built-ins such as `pg_notify` and `setval` (`[denylisted-call]`). Put a marker with a reason directly before the statement:

```sql
-- OVERRIDE SUPER-DEPLOY REFUSAL: loads the staging table named by the caller
create function load_staging(source text) returns void language plpgsql as $$
begin
  execute format('insert into app.staging select * from %I', source);
end $$;
```

- The marker covers only the next statement, and it must give a reason. A marker that isn't needed is refused.
- It works in the desired schema and in a draft's hand-written files.
- Overrides are recorded in `metadata.json` and listed by `validate`. Reviewers must read what an `EXECUTE` builds.

## When a deploy fails

A failed deployment **rolls back completely**. The target is unchanged and records none of the pending migrations.

```mermaid
flowchart TD
  F["deploy fails on migration 8"] --> W{"why?"}
  W -->|"connection lost<br>or timeout"| RT["Retry once the<br>target is reachable"]
  W -->|"target has drifted"| DR["See Drift"]
  W -->|"data refused by<br>the migration"| R1["recovery --migration 8"]
  R1 --> R2["Reproduce the bad rows<br>in seed-data.sql"]
  R2 --> R3["Fix pre-migration.sql<br>or post-migration.sql"]
  R3 --> R4["rehearse, then finalize"]
  R4 --> R5["00008-…/recoveries/recovery-1/"]
  R5 --> R6["The next deploy runs Recovery 1<br>in place of the original scripts"]
```

- A Recovery always reuses its migration's `schema-change.sql`, so don't edit it.
- Targets that already ran migration 8 keep their record. Migration 8's own hashes don't change.
- Only a connection lost **during COMMIT** leaves the outcome unknown. The next `status` settles it.

## Drift

`deploy` builds a replica of what a target's recorded migrations should produce, and compares it with the target's managed schema. Any difference is drift, and `deploy` refuses until it is resolved. `status --target <t>` lists each difference.

Not compared: grants, policies, RLS, ownership (checked separately) and column order.

```mermaid
flowchart TD
  D["status shows drift"] --> Q{"what to do with<br>the hand-made change?"}
  Q -->|undo it| U["Reverse it on the target<br>until status shows 'Drift: none'"]
  Q -->|keep it| K["Add it to the desired schema<br>draft → finalize<br>mark --target t"]
  Q -->|"wipe it<br>(disposable only)"| B["rebuild --target t --to N<br>loses the data"]
```

## Changing your mind

```mermaid
flowchart TD
  S{"What do you<br>want to undo?"} -->|"the draft"| A["discard-draft<br>keeps the desired schema"]
  S -->|"desired-schema edits<br>and the draft"| B["restore-schema<br>resets to the newest snapshot"]
  S -->|"the newest migration,<br>which no target has run"| C["unfinalize<br>moves it back into the draft"]
  S -->|"a migration a target<br>has already run"| D["Finalize a new migration,<br>or a Recovery"]
```

Each command asks before it overwrites anything. Without a terminal, pass `--acknowledge-overwrite`. `unfinalize --recovery-of N` reopens migration N's newest Recovery.

> [!CAUTION]
> **Never `unfinalize` a migration that any target has recorded, even `dev`.** That target's `deploy` then refuses: `the target records migration … with content hash …`.
>
> To repair this, finalize the draft unchanged with the same tool versions, which reproduces the migration byte for byte. Or restore the folder and `migrations/index.json` from Git, then run `validate`.

**A finalized file was changed** (`changed after it was finalized`): run `git checkout HEAD -- data-model/migrations/<folder>`, then `validate`. **Stray or missing files** (`unknown-migration-file`, `missing-migration-file`): move them out, or restore them from Git, then run `validate`.

## Disposable targets and the guarded commands

A **disposable** target is flagged as safe to wipe. Every target starts out not disposable, `dev` included. The flag is stored in the target's history schema, not in the config, so no config change can make production disposable.

```sh
pnpm exec super-deploy disposable --target dev --set yes   # then type YES
```

| Command | Needs a disposable target | What it does |
| --- | :---: | --- |
| `disposable --target t --set yes\|no` | — | Sets the flag. Shows the table and row counts first. |
| `deploy-draft --target t [--with-seed]` | ✅ | Runs the unfinalized draft on the target, with no rehearsal. The target then refuses `deploy` until `rebuild`. |
| `rebuild --target t --to N` | ✅ | Drops everything in the managed schema, plus dependent objects in other schemas, and replays migrations 1 to N. `N` can be `0`. Keeps the flag and the attempt log. |
| `mark --target t` | — | Records the next pending migration as deployed without running it. The target must match a replica exactly. Make the scripts' data changes by hand. |

```mermaid
flowchart LR
  T["dev at migration N"] -->|deploy-draft| DD["dev holds the draft<br>deploy refuses"]
  DD -->|"rebuild --to N"| T
  T -->|"finalize, then deploy"| T2["dev at N+1"]
```

All four commands show the target's name, host, database and last migration, and go ahead only if you type `YES`. They refuse in CI and without a terminal, and no flag skips the question.

Deleting `.super-deploy/` loses `dev`'s flag. `rebuild` keeps it.

## Interrupting a command

Ctrl+C (SIGINT), SIGTERM or SIGHUP stops the command after it cleans up: an in-progress deployment rolls back, throwaway databases are dropped, and servers stop. The exit code is 130, 143 or 129. A command that changes a target then reports what happened to it, either `rolled back: target qa is unchanged` or `had already finished`. Interrupting a second time exits at once, without cleaning up.

> [!WARNING]
> **In CI or under a supervisor**, run `./node_modules/.bin/super-deploy deploy …` directly, not `pnpm exec`. With pnpm installed through corepack, SIGTERM stops only pnpm's launcher, and the deployment carries on and commits. After a cancelled job, check with `status --target <t>`.
