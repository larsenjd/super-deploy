# super-deploy V1 spec

Status: ready-for-agent

A deterministic, declarative schema deployment system for PostgreSQL 18. Developers edit a desired schema; the system generates the schema change, freezes it with hand-written scripts into an immutable migration, and deploys every pending migration to a target in one all-or-nothing transaction. A SQL parser enforces an allowlist so nothing in a deployment can break that transaction.

Vocabulary is defined in `GLOSSARY.md` and used exactly as defined here. Architectural decisions are in `docs/adr/`. Deliberate V1 narrowings, and what would justify revisiting them, are in `REFINEMENTS.md`. Research backing the rules is in `.scratch/super-deploy/research/`. `(Qn)` tags trace each decision to the design session.

---

## 1. Goals and guarantees

1. **Immutable migrations.** A finalized migration never changes. Its files are hash-chained; any edit fails `validate`. (Q10, Q36)
2. **All-or-nothing deployments.** Every pending migration on a target deploys in one transaction. (ADR-0001)
3. **Declarative authoring.** Developers edit the desired schema; the system generates the schema change. (Q3, ADR-0003)
4. **Structural determinism.** (Q2)
   - Deploying runs only frozen SQL. The differ never runs at deploy time; a newer differ only affects new drafts.
   - Given the same migrations and the same starting structure, a target ends in the same structure. Rehearsals and drift checks verify it.
   - Data is **not** required to be deterministic. Volatile functions (`now()`, `gen_random_uuid()`, …) are allowed and produce different values per target. (Q41)
5. **Cross-platform.** Windows, macOS and Linux. Repo scripts are TypeScript run by pnpm, never bash or PowerShell.

---

## 2. Architecture

| Concern | Decision |
|---|---|
| Language/runtime | TypeScript, Node ≥ 24 LTS, ESM only, strict. Built with plain `tsc` (JS + `.d.ts`), no bundler. (Q1, Q59) |
| Reading the desired schema | Apply its SQL to an empty throwaway database and read PostgreSQL's catalogs. Never model the schema by parsing SQL. (Q3, ADR-0003) |
| Differ | Behind our own `Differ` interface. V1 wraps `@supabase/pg-delta`, pinned to an exact version, **subject to the prototype** (issue 01). Fallback: our own `pg_catalog`/`pg_depend` differ behind the same interface. Column order is never a difference. (Q7, Q17) |
| Differ verification | Independent of engine: apply the generated migration to a fresh database, read it back, require an empty diff against the desired schema. (Q17) |
| SQL parser | `libpg-query@18` (WASM, PG18 grammar) with `@pgsql/types`, pinned to exact versions. Used only to enforce rules. PL/pgSQL bodies are parsed with its PL/pgSQL parser. (Q18, Q29, ADR-0002) |
| Throwaway databases | Supplied by the rehearsal adapter (§10). |
| CLI | `@clack/prompts` for the menu and prompts; Node's `util.parseArgs` for flags. One set of command definitions drives both. (Q57) |

---

## 3. Project layout

```
<project>/
  super-deploy.config.ts
  data-model/                       # configurable: `directory`
    schema/                         # desired schema (*.sql)
    draft/
      draft.json                    # draft name; kind (migration | recovery of N)
      pre.sql
      schema-change.sql             # generated, never hand-edited
      post.sql
      seed.sql
    migrations/
      index.json                    # hash chain
      00001-adopt/
        pre.sql  schema-change.sql  post.sql  seed.sql  meta.json
        schema/                     # desired-schema snapshot at finalize
      00003-add-orders/
        ...
        recoveries/
          00001-fix-null-emails/
            pre.sql  post.sql  seed.sql  meta.json
```

- The snapshot is what `unfinalize` and `restore-schema` restore from. Diffing replays migrations instead (§5.2). (Q34)
- **One draft at a time**: either a normal draft or a Recovery draft, never both. (Q50)

### 3.1 Naming (Q34, Q39)

- Folder name: `<5-digit zero-padded number>-<kebab-case description>`, e.g. `00001-add-orders-table`. Recoveries use the same pattern under their migration's `recoveries/`.
- Description: `[a-z0-9]+(-[a-z0-9]+)*`, at most 60 characters.
- Set by `draft --name <name>` or asked for interactively; editable until `finalize`.
- Input normalisation (interactive and `--name` alike): trim → lowercase → collapse runs of spaces into one hyphen → refuse any remaining character outside `a-z0-9-`, showing the offending characters. The interactive prompt previews the result before anything is created.
- The number is the identity; the description is a label. The hash covers the folder name, so renaming a finalized folder fails `validate`.

### 3.2 Desired-schema file order — PENDING (Q35)

Undecided until the differ prototype (issue 01). See `.scratch/super-deploy/pending-decisions.md`. **Ask the user before choosing.**

- If pg-delta's directory loader reliably orders files by dependency on PG18: no ordering convention.
- Otherwise: apply files in path order (raw code-point sort of `/`-separated relative paths, folders included; paths differing only by case are refused), with numbered prefixes by convention.

---

## 4. Rules

Two rule sets, both enforced by the parser as **allowlists**: anything not explicitly approved is refused, including syntax from later PostgreSQL versions. (Q4, Q5, ADR-0002)

### 4.1 Desired-schema rules (Q5, Q8, Q22, Q28, Q31, Q40, Q48, Q49, Q65)

Allowed statements:
- `CREATE` for supported object types (below).
- `COMMENT ON` and `GRANT` on managed objects.
- Exactly these `ALTER TABLE` forms: `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, `ADD CONSTRAINT` (for circular foreign keys).
- `CREATE EXTENSION plpgsql` only (it is present anyway).

No DML, no `DO` blocks, no other `ALTER`.

**Supported object types:** tables (incl. stored and virtual generated columns); constraints: primary key, foreign key, unique, check, exclusion, NOT NULL; indexes; views; materialized views; identity sequences (`GENERATED … AS IDENTITY`); functions; procedures; triggers; domains; composite types; row-level security policies; comments; grants.

**Refused:** enums; partitioned tables; every extension except `plpgsql`; `CREATE RULE`; event triggers; foreign tables and foreign data wrappers; publications and subscriptions; custom casts, operators, aggregates (`CREATE AGGREGATE`; using built-in aggregates in queries is fine), collations and text-search configurations; standalone sequences; `CREATE STATISTICS`; `serial`/`bigserial` columns; `NOT ENFORCED` constraints.

**Schemas:** objects live in the managed schema. They may reference `pg_catalog` and nothing else, **except** that PL/pgSQL routine bodies may reference **external schemas** declared in config. (Q22, Q28)
- Only PL/pgSQL bodies resolve names at run time, so only they can reference objects absent from rehearsals. `LANGUAGE sql` bodies, `BEGIN ATOMIC` bodies, views, foreign keys, defaults and triggers bind at `CREATE` and will fail in rehearsal if they reference an external schema.
- `check_function_bodies` stays **on**.
- References in PL/pgSQL bodies to schemas not declared in `externalSchemas` are refused (catches typos).

### 4.2 Deploy-time SQL rules

Apply to every file that runs against a target: generated schema changes, pre-migration scripts, post-migration scripts and seed data. Checking the generated schema change means a differ bug cannot bypass the rules. (Q5)

**Never allowed (break or escape the transaction):** every statement PostgreSQL refuses inside a transaction block (`CREATE/DROP/REINDEX … CONCURRENTLY`, `DETACH PARTITION CONCURRENTLY`, `VACUUM`, `CREATE/DROP DATABASE`, tablespaces, `ALTER SYSTEM`, `DISCARD ALL`, `CLUSTER` without a table, subscription commands, prepared transactions, …); `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `ROLLBACK TO`, `RELEASE`; `CALL`; `DO`. The full list with sources: `research/transactional-hazards.md` §1, §4. (Q1, Q6, Q12)

**Functions:** only functions in `pg_catalog`, minus a denylist of built-ins whose effects escape the transaction: `setval`, `pg_notify`, advisory lock functions, `dblink*`, `lo_import`/`lo_export` and other large-object server functions, `pg_terminate_backend`/`pg_cancel_backend` and other signal/admin functions, replication-slot functions, `set_config`, file-access functions (`pg_read_file`, …). User-defined functions may not be called directly. Triggers firing from DML is accepted. Volatile built-ins are allowed. (Q6, Q41; `research/transactional-hazards.md` §2)

**Column order (Q7):** refused: `INSERT` without a column list; `SELECT *` and `t.*` (including `RETURNING *`, `RETURNING old.*/new.*`); `ORDER BY`/`GROUP BY` ordinals; `NATURAL JOIN`; whole-row references to a table's row type; `COPY` in any form. Full list: `research/transactional-hazards.md` §7.

**Identity columns (Q40):** no explicit values into identity columns (`OVERRIDING SYSTEM VALUE`, or explicit values into `BY DEFAULT` identities). Reference-data tables use natural keys.

**DML (Q42):**

| Statement | Rule |
|---|---|
| `INSERT` (with column list), `UPDATE`, `MERGE` | Allowed |
| `DELETE`, `TRUNCATE` | Allowed, destructive (§4.5) |
| `CREATE TEMP TABLE … ON COMMIT DROP` (incl. `AS SELECT …`) | Allowed (Q44) |
| Any other temp table; `SELECT INTO` / `CREATE TABLE AS` creating a permanent table | Refused |
| `COPY` | Refused |
| Standalone `SELECT` | Refused |

**Other statements (Q47):**

| Statement | Rule |
|---|---|
| `SET`, `RESET`, `SET CONSTRAINTS` | Refused (the tool pins session settings, §7.4) |
| `GRANT`, `REVOKE`, `COMMENT` | Refused in scripts (the desired schema owns them; allowed in generated schema changes) |
| `LISTEN`, `NOTIFY`, `PREPARE`, `DECLARE`, `LOAD` | Refused |
| `LOCK TABLE` | Allowed |
| `ANALYZE` | Allowed |
| `REFRESH MATERIALIZED VIEW` | Allowed; `CONCURRENTLY` refused |

**References (Q45):** deploy-time SQL may read and write only the managed schema and its own temp tables, and read `pg_catalog`. No external schemas: rehearsals cannot contain them.

**Per-file restrictions:**
- **Pre-migration script:** DDL on managed objects (anything the desired-schema and deploy-time rules allow, plus `ALTER … RENAME`, column type changes, etc.) and DML. It runs before the diff (§5.2), so it is where renames, data-preserving type changes and add–backfill–`SET NOT NULL` go. (Q16)
- **Post-migration script:** DML only. No DDL, so it cannot move structure away from the desired schema. (Q16)
- **Seed data:** `INSERT` with column lists only. (Q15)

### 4.3 PL/pgSQL body rules (Q29)

Every PL/pgSQL function/procedure body in the desired schema (and therefore in generated schema changes) is parsed. Refused:
- `EXECUTE` (dynamic SQL), unless overridden (§4.4).
- `COMMIT` / `ROLLBACK` in procedures. Never overridable.
- Calls to the deploy-time function denylist (§4.2), unless overridden.
- References to schemas other than the managed schema, `pg_catalog` and declared external schemas.

### 4.4 Override marker (Q24, Q30)

- Exact form, on the line immediately before the statement: `-- OVERRIDE DANGEROUS COMMAND: <reason>`. Reason required.
- Scope: that one statement.
- Recorded against the object's identity (e.g. `function load_orders(int)`), not its position, so it survives the differ regenerating the object in a schema change.
- May override only risk rules (dynamic SQL, denylisted functions). Never rules that would break the transaction (`COMMIT`, `CONCURRENTLY`, `VACUUM`, …).
- Every override is listed in the migration's `meta.json`, printed by `finalize`, and reported by `validate`.

### 4.5 Destructive changes (Q25)

`finalize` refuses a draft whose deploy-time SQL drops structure or deletes data — `DROP …`, dropping a column, lossy column type changes, `DELETE`, `TRUNCATE` — unless `--acknowledge-destructive` is passed or confirmed at the prompt. The acknowledgement and the statements it covers are recorded in `meta.json`.

### 4.6 Warnings (Q46)

`finalize` warns (does not fail) for each statement that rewrites or fully scans an **existing** table: `ALTER COLUMN TYPE`, volatile default, `SET NOT NULL`, validating a foreign key or check, `CREATE INDEX`, `TRUNCATE`. Tables created in the same migration are exempt. Every lock is held until commit (ADR-0001). No warnings for volatile functions (Q41).

---

## 5. Authoring

### 5.1 Workflow

1. Edit the desired schema in `schema/`.
2. `draft [--name <name>]` creates the draft or regenerates its schema change, and reports what scripts must cover.
3. Fill in `pre.sql`, `post.sql`, `seed.sql` as needed. Re-run `draft` whenever the desired schema or pre-migration script changes.
4. `rehearse` (optional): replay every migration plus the draft on a throwaway database and check the result matches the desired schema.
5. `finalize [--acknowledge-destructive]`: rehearse again, then freeze the draft as the next migration (or Recovery).
6. Commit. Pre-commit runs `validate --strict`.

### 5.2 How `draft` generates the schema change (Q16)

1. Load the desired schema into throwaway database **D**.
2. In throwaway database **R**, replay every finalized migration (each with its newest variant), then load the draft's seed data, then run the draft's pre-migration script.
3. Diff R → D. The result is the schema change.
4. Report anything unresolved, e.g. a column dropped from a table that has data, or a table whose change needs a rename the pre-migration script hasn't done.

### 5.3 Rehearsal

A rehearsal replays migrations on a throwaway database and checks the result. For a draft:
1. Replay finalized migrations (newest variant each).
2. Load the draft's seed data.
3. Run pre-migration script → schema change → post-migration script.
4. Read back and require an empty diff against the desired schema.

Throwaway databases are created to match the target's (or config default) encoding, locale and collation provider. (Q19)

### 5.4 Seed data (Q11, Q14, Q15, Q27)

- Reproduces a real target's problem conditions so a rehearsal proves the scripts handle them.
- Belongs to one migration (or Recovery). Frozen with it at finalize as an audit record.
- Loaded **only**: in rehearsals of the draft it belongs to (including `finalize`'s), and in `deploy-draft --with-seed` (opt-in, off by default).
- **Never** loaded: when finalized migrations are replayed, in `deploy`'s rehearsal, in `rebuild`, or on any non-disposable target.
- Committed to git: must be synthetic or anonymised. The tool cannot enforce this; the template and `init` docs must say so.

### 5.5 Other authoring commands

| Command | Does |
|---|---|
| `unfinalize [--acknowledge-overwrite]` | Moves the newest migration or Recovery back into the draft; restores the desired schema from the previous snapshot. |
| `restore-schema [--acknowledge-overwrite]` | Resets the desired schema to the newest migration's snapshot and deletes any draft. |
| `discard-draft [--acknowledge-overwrite]` | Deletes the draft; leaves the desired schema alone. |
| `validate [--strict]` | Checks the index, hashes, chain, read-only state, rules and overrides of finalized files; warns about the draft and undrafted desired-schema changes. `--strict` turns warnings into failures. |

---

## 6. Migrations and integrity

### 6.1 Hashing (Q36)

- Files are read as UTF-8; a BOM is refused. Line endings are normalised to LF before hashing.
- SHA-256. `content_hash[n]` covers every file in the migration folder, including its folder name and `meta.json`.
- `chain[n] = sha256(chain[n-1] + content_hash[n])`, stored in `migrations/index.json`.
- Finalized files are made read-only with `fs.chmod(0o444)` (sets the read-only attribute on Windows).
- The template ships `.gitattributes`: `*.sql text eol=lf`, `*.json text eol=lf`.

### 6.2 `meta.json` (Q17, Q33)

Frozen and hashed. Contains: tool version; differ name and version; parser version; PostgreSQL server version the rehearsal ran on; destructive acknowledgement and the statements it covered; overrides with reasons and object identities. **No** timestamps or usernames (git has them; leaving them out keeps files reproducible).

### 6.3 Recoveries (Q10, Q13)

- `recovery --migration <N>` creates a Recovery draft for N; `finalize` freezes it as `NNNNN-…/recoveries/NNNNN-…/`.
- Replaces N's pre-migration script, post-migration script and seed data. **Never** the schema change.
- Newest Recovery wins for targets that have not recorded N. Targets that recorded N are never affected; their history says which variant they ran.
- Rehearsal guarantees the original and every Recovery end in structurally identical results; only data may differ.

---

## 7. Deploying

### 7.1 History schema (Q37, Q55)

Created by the first `deploy` to a target, inside its transaction. Default name `deployment_history` (configurable).

| Table | Contents | Written |
|---|---|---|
| `migrations` | number, name, variant (original or Recovery K), content hash, chain hash, attempt id, how recorded (`deployed` / `marked`) | Inside the deploy transaction |
| `attempts` | command, target, migration range, OS username, tool version, start/end time, outcome (`running`, `succeeded`, `failed`, `abandoned`, `unknown`), error | On a second connection, outside the transaction |
| `settings` | disposable flag (new targets: not disposable) | By the guarded `disposable` command |

### 7.2 Locking (Q54)

`deploy`, `mark`, `rebuild`, `deploy-draft` and `disposable` take a session-level advisory lock with `pg_try_advisory_lock` on their own connection, keyed from the history schema name. A second command fails immediately: "target is locked by attempt #N". Scripts still may not use advisory locks.

### 7.3 `deploy --target X` sequence (Q53)

1. Open the attempt (`running`) on the attempt connection.
2. Take the advisory lock.
3. Pre-flight checks:
   - Every role granted to in the desired schema exists on the target; refuse if any is missing. (Q66)
   - Every declared external schema exists on the target. (Q28)
   - Warn if the deploy role is superuser or holds `pg_write_server_files`, `pg_execute_server_program` or `pg_signal_backend`. (Q24, Q32)
   - Verify the target's recorded migrations match the repo's hashes.
4. **Drift check:** replay the target's recorded migrations (each with its recorded variant) on a throwaway database matching the target's encoding/locale/collation provider. Any structural difference from the target's managed schema (ignoring column order and ownership) is drift → refuse. No exceptions. (Q38)
5. **Rehearsal:** apply the pending migrations (newest Recovery where one exists) to that database. The result must match the newest migration's desired-schema snapshot.
6. **Real run:** one transaction on the target (§7.4). Each migration's history row is written inside it.
7. Close the attempt: `succeeded` / `failed`.

### 7.4 Inside the deploy transaction (Q20)

- `SET LOCAL search_path = <managed schema>, pg_catalog`; `TimeZone = 'UTC'`; fixed `DateStyle` and `IntervalStyle`; `lock_timeout` (per target, default `5s`); `statement_timeout` (per target, default unset). Identical in rehearsals.
- Per migration: pre-migration script → schema change → post-migration script, each file as its own statement batch so errors name the file. `SET CONSTRAINTS ALL IMMEDIATE` at each migration boundary.
- No savepoints. No automatic retry.

### 7.5 Unknown outcome at COMMIT (Q21)

If the connection drops during COMMIT, the attempt is marked `unknown`. The next `status` or `deploy` settles it by reading the `migrations` rows (written inside the transaction): present → `succeeded`, absent → `failed`.

### 7.6 Recovery ladder

1. **Retry:** fix the cause and deploy again.
2. **Recovery:** replace the failed migration's scripts for targets that haven't run it (§6.3).
3. **Mark:** someone fixed the target by hand; record the migration as deployed (§7.7).

### 7.7 `mark` 🔒 (Q52)

- Only the target's **next** pending migration; repeat to mark several.
- Builds a replica of 00001..N on a throwaway database matching the target's locale; proceeds only on an empty diff against the target's managed schema (ignoring column order and ownership).
- Records the original variant of N.
- Writes **only** to the target's history schema (`migrations` row recorded as `marked`; manual `attempts` row under the OS username). Nothing in the repo changes.

### 7.8 `status --target X`

Reports pending migrations, drift, the disposable flag, recent attempts (settling any `unknown`), missing roles and external schemas, and deploy-role privilege warnings. Exits 1 on drift or refusal, so scheduled jobs fail.

---

## 8. Disposable targets (Q14, Q27)

The disposable flag lives in the target's history schema, never in config, so editing config can't make `prod` disposable. All four commands are guarded (§9.4).

| Command | Does |
|---|---|
| `disposable --target X --set yes\|no` | Sets the flag. |
| `deploy-draft --target X [--with-seed]` | Deploys the current draft to a disposable target. Seed data only with `--with-seed`. |
| `rebuild --target X --to N` | Wipes the managed schema and replays migrations 00001..N. Never loads seed data. |

---

## 9. Command line

### 9.1 Commands (Q50)

| Section | Command | Options |
|---|---|---|
| **Start** | `init` | `--adopt <target>` |
| **Author** | `draft` | `--name <name>` |
| | `rehearse` | — |
| | `finalize` | `--acknowledge-destructive` |
| | `unfinalize` | `--acknowledge-overwrite` |
| | `restore-schema` | `--acknowledge-overwrite` |
| | `discard-draft` | `--acknowledge-overwrite` |
| | `validate` | `--strict` |
| **Deploy** | `status` | `--target <name>` |
| | `deploy` | `--target <name>` |
| **Recover** | `recovery` | `--migration <N>` |
| | `mark` 🔒 | `--target <name> --migration <N>` |
| **Disposable** | `deploy-draft` 🔒 | `--target <name>` `--with-seed` |
| | `disposable` 🔒 | `--target <name> --set yes\|no` |
| | `rebuild` 🔒 | `--target <name> --to <N>` |

No `setup` command: embedded PG binaries arrive as an npm dependency of the template. (Q50)

### 9.2 Two ways to run

- **Direct:** `super-deploy <command> [options]`. Fully scriptable; nothing prompts unless a terminal is attached.
- **Interactive:** no arguments in a terminal → menu grouped by section. After a command, the menu returns on that command. Failures print and return to the menu. Cancelling a question runs nothing. `quit`, Escape or Ctrl+C leaves. No arguments and no terminal → usage text, exit 2.

### 9.3 Option kinds

- **Target:** must exist in config; the menu picks from configured targets.
- **Migration** (`--migration`, `--to`): a finalized migration's number; the menu shows a searchable list, newest first.
- **Choice** (`--set`): fixed values with labels.
- **Name** (`--name`): normalised per §3.1.
- **Flag** (`--acknowledge-*`, `--strict`, `--with-seed`): off by default. The menu never sets `--acknowledge-*`; the command asks yes/no (default no) at the moment it matters. Without a terminal the flag is the only way to say yes. The menu asks for `--with-seed` explicitly, default no.

Unknown, repeated, missing or invalid options are usage errors; nothing runs.

### 9.4 Guarded commands 🔒

`mark`, `rebuild`, `deploy-draft`, `disposable`:
1. Refuse in CI, or when stdin or stdout isn't a terminal.
2. Check preconditions (e.g. target is disposable).
3. Show the exact action plus the target's name, host, database and last recorded migration.
4. Proceed only if the user types `YES` exactly.
5. Record a manual attempt under the OS username.

Nothing skips this: no flag, environment variable or API option.

### 9.5 Shared behaviour

- `--help` lists commands; `<command> --help` describes its options.
- Results to stdout; warnings and progress ("Rehearsing 3 (3 of 5)") to stderr.
- Failures print one line `Error: <message>` naming the command or target. `--debug` adds stack traces and causes.
- Project discovery: find `super-deploy.config.ts` in the current directory or the nearest parent. Paths written are shown relative to the cwd; paths in errors relative to the project root.
- Interruption (Ctrl+C, SIGTERM, closed output pipe): roll back the open transaction, release the advisory lock, mark the attempt `abandoned`, discard throwaway databases, print one notice. A second interrupt exits at once.

| Exit code | Meaning |
|---|---|
| 0 | Success |
| 1 | Failed or refused (`status` also on drift) |
| 2 | Usage error; nothing ran |
| 130 | SIGINT, cleaned up |
| 141 | Output closed, cleaned up |
| 143 | SIGTERM, cleaned up |

### 9.6 Programmatic API

Every command is an exported function taking a loaded project. Flags become options; terminal questions become callbacks. Failures throw typed errors instead of setting exit codes. Guarded commands remain terminal-only.

### 9.7 `init` and `init --adopt` (Q51)

- `init` scaffolds a new project from the template (shipped inside the library package).
- `init --adopt <target>`:
  1. Read the target's managed schema.
  2. Generate desired-schema files from it (differ: empty → target).
  3. Create migration `00001-adopt`.
  4. Record it on the target as `marked`, using the same replica check as `mark`.
  - Refuses if the managed schema contains anything V1 refuses (§4.1), listing every offending object.

---

## 10. Configuration (Q9, Q56)

`super-deploy.config.ts` at the project root, typed via `defineConfig()`, loaded with Node's built-in TypeScript type stripping (no `enum`/`namespace` in the config). (Q59)

| Setting | Default | Notes |
|---|---|---|
| `postgresVersion` | required | Must be `18`. |
| `rehearsal` | required | Rehearsal adapter. |
| `targets` | `{}` | Per target: deployment adapter, `lockTimeout` (default `5s`), optional `statementTimeout`. |
| `managedSchema` | `public` | The one schema the tool owns. |
| `historySchema` | `deployment_history` | |
| `externalSchemas` | `[]` | Schemas PL/pgSQL bodies may reference (§4.1). |
| `directory` | `data-model` | |

Not in config: credentials, the disposable flag, migration state.

### 10.1 Adapters

The library never starts PostgreSQL or opens a connection by itself; it calls adapters.

- **Deployment adapter** (per target): "give me a session on this database." A session runs SQL, runs queries, reports its PostgreSQL version and closes. Called each time a command connects, so commands that don't touch `prod` never need its credentials. `deploy` opens two sessions (transaction + attempt log).
- **Rehearsal adapter** (per project): "give me an empty throwaway database on PostgreSQL N with this encoding, locale and collation provider, and drop it when I'm done." Its login needs `CREATEROLE` (§10.2). (Q19)
- The library ships node-postgres adapters configured from a connection string or environment variable.
- The template's adapter uses `embedded-postgres` (PG18) to provide rehearsal databases and the `dev` target.
- The library checks what adapters give it, e.g. refuses a server whose major version isn't 18.

### 10.2 Roles (Q23, Q66)

Roles are out of scope: never created or dropped on targets. Grants on managed objects to existing roles are diffed. Ownership is not diffed; objects are owned by the deploying role. Rehearsals create any missing granted role as `NOLOGIN` and never drop it.

---

## 11. Repo and tooling (Q58–Q63)

- **pnpm workspace:**
  - `packages/super-deploy`: library and CLI. Its build copies `packages/template` into the package.
  - `packages/example`: a working project using the library.
  - `packages/template`: what `init` copies.
  - Root: `GLOSSARY.md`, `REFINEMENTS.md`, `docs/`, workspace config. Root Biome config excludes `packages/`.
- **Scripts:** every cross-package script runs as `pnpm -r <script>` (`format`, `lint`, `typecheck`, `test`, `precommit`); the root only orchestrates. Repo scripts are TypeScript run by Node. (Q61)
- **Lint/format:** Biome for TS and JSON. The Postgres Language Server is recommended for in-editor SQL diagnostics. No automatic SQL formatting in V1. (Q60)
- **Pre-commit:** Husky runs `pnpm precommit` → root checks, then `pnpm -r precommit`.
  - Library: Biome check, typecheck, unit tests.
  - Example and template: Biome check, typecheck, `validate --strict`.
- **VS Code:** `super-deploy.code-workspace` with root and each package as folders, each with its own `.vscode/` (recommended extensions incl. Biome and Postgres Language Server). Editor format-on-save off; a run-on-save extension calls `pnpm run format:file` in the nearest package. The template sets `files.readonlyInclude` for `data-model/migrations/**` and `data-model/draft/schema-change.sql`.
- **Testing:** Vitest, developed test-first.
  - Unit: fixture-driven rule suite. Every hazard in `research/transactional-hazards.md` has at least one "refused" fixture; every allowed statement an "allowed" fixture.
  - Integration: real PG18 via `embedded-postgres`, covering draft, rehearse, finalize, deploy, drift, recovery, mark, interruption, unknown COMMIT outcome.
  - CI: GitHub Actions on Ubuntu, macOS and Windows with Node 24.
- **Publishing:** not in V1 (see `REFINEMENTS.md`).

---

## 12. Out of scope for V1

Everything in `REFINEMENTS.md`, notably: calling user functions in scripts, enums, non-transactional operations, tolerating drift, replacing a schema change in a Recovery, ongoing seed data, extensions beyond `plpgsql`, partitioning, assertions, size-aware warnings, SQL formatting, ownership and default privileges, publishing.
