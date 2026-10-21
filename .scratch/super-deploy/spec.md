# super-deploy V1

Status: ready-for-agent

Vocabulary follows `GLOSSARY.md`. Architectural decisions: `docs/adr/0001`–`0006`. Deliberate V1 narrowings: `REFINEMENTS.md`. Research and prototype findings: `.scratch/super-deploy/research/`. `(Qn)` tags trace decisions to the design session.

## Problem Statement

Teams deploying schema changes to PostgreSQL get a database that is sometimes half-migrated and often subtly different from what they intended. Hand-written migrations drift from the schema people think they have; a failure partway through a run leaves some migrations applied and others not; SQL that works in development behaves differently in production because of locks, transaction semantics or column order; and nobody can say with confidence what structure a given database should have.

Declarative tools (edit the schema, generate the SQL) remove the hand-writing but are fragile: they can emit statements that cannot run inside a transaction, guess wrong about renames, and leave no frozen, auditable record of what was actually run. Teams need the convenience of declarative authoring with the guarantees of immutable migrations: every target reaches exactly the intended structure, or is left exactly as it was.

## Solution

`super-deploy` is a TypeScript library and CLI for PostgreSQL 18. Developers edit a **desired schema** in SQL files. The system generates the **schema change**, the developer adds hand-written **pre-migration** and **post-migration scripts** for what generation can't do, and the result is frozen as a numbered, hash-chained, immutable **migration**. A **deployment** applies every **pending migration** on a **target** in one transaction: all or nothing.

Fragility is contained by rules, not hope. PostgreSQL's own parser checks every SQL file against an allowlist, so nothing that could break or escape the deploy transaction is ever accepted. Every draft is **rehearsed** on throwaway databases before it can be finalized, and every deployment is rehearsed again and checked for **drift** before it touches the target. When a deployment fails, a recovery ladder (retry, **Recovery**, mark) gives a safe way forward. Disposable targets and **seed data** let developers reproduce and fix real data problems before production sees them.

It runs identically on Windows, macOS and Linux, from a terminal menu, from flags in CI, or as a programmatic API.

## User Stories

### Authoring

1. As a developer, I want to describe the database I want in plain SQL files, so that I never hand-write the `ALTER` statements to get there.
2. As a developer, I want to organise desired-schema files however I like, without numbering them, so that the folder reflects my domain rather than load order.
3. As a developer, I want the system to work out the order to load my desired schema automatically, so that cross-file references just work.
4. As a developer, I want circular foreign keys between two tables to be expressible, so that real-world schemas aren't rejected.
5. As a developer, I want unknown references and dependency cycles reported with file and line before anything loads, so that I can fix typos quickly.
6. As a developer, I want the loaded result to never depend on file names or load order, so that renaming a file can't silently change which function a view uses.
7. As a developer, I want to run `draft` and get a generated schema change from the newest migration to my desired schema, so that I can review exactly what will run.
8. As a developer, I want to name a draft (typing spaces is fine) and see the normalised kebab-case name before it's created, so that migration folders are readable and consistent.
9. As a developer, I want to rename a draft until it's finalized, so that a first guess at a name isn't permanent.
10. As a developer, I want my pre-migration script to run before the diff is computed, so that renames, data-preserving type changes and add–backfill–`SET NOT NULL` sequences done there aren't regenerated as destructive drop-and-add.
11. As a developer, I want `draft` to tell me what my scripts still need to cover (such as a dropped column on a table with data), so that I don't lose data by accident.
12. As a developer, I want to re-run `draft` whenever I change the desired schema or pre-migration script, so that the schema change stays in step.
13. As a developer, I want post-migration scripts for data work like backfills and reference data, so that data changes ship with the structure that needs them.
14. As a developer, I want post-migration scripts to be refused if they contain DDL, so that the structure can't drift away from the desired schema.
15. As a developer, I want to stage data in `ON COMMIT DROP` temporary tables during a migration, so that complex data reshaping is possible without leaving tables behind.
16. As a developer, I want to add seed data that reproduces a production data problem, so that the rehearsal proves my scripts handle it.
17. As a developer, I want seed data to exist only for the rehearsals of its own draft, so that old troubleshooting data doesn't burden later migrations.
18. As a developer, I want `rehearse` to replay every migration plus my draft on a throwaway database and prove the result matches my desired schema, so that I find problems before finalizing.
19. As a developer, I want rehearsals to fail if the desired schema produces a different catalog in a different valid load order, so that hidden order dependence is caught.
20. As a developer, I want `finalize` to freeze my draft as the next numbered migration with read-only files and a hash-chain entry, so that it can never change afterwards.
21. As a developer, I want `finalize` to refuse destructive changes (drops, `DELETE`, `TRUNCATE`, lossy type changes) unless I acknowledge them, so that data loss is always a deliberate choice.
22. As a developer, I want the destructive acknowledgement recorded in the migration, so that reviewers can see what was accepted.
23. As a developer, I want `finalize` to warn me about statements that rewrite or fully scan existing tables, so that I know which locks will be held until commit.
24. As a developer, I want to `unfinalize` the newest migration back into a draft, with the desired schema reset to that migration's own snapshot (the desired schema it was finalized from), so that I can fix a mistake I haven't shipped.
25. As a developer, I want to `restore-schema` to the newest migration's desired schema, so that I can abandon unfinished edits.
26. As a developer, I want to `discard-draft` while keeping my desired schema, so that I can regenerate from scratch.
27. As a developer, I want overwrite-type commands to ask before discarding work, and to refuse without a flag in non-interactive use, so that nothing is lost by accident.
28. As a developer, I want each migration to record which tool, differ, parser and PostgreSQL versions produced it, so that I can explain any generated SQL later.
29. As a developer, I want migration files to contain no timestamps or usernames, so that they're reproducible and git remains the record of who and when.

### Rules

30. As a developer, I want every SQL file that could run in a deployment checked by PostgreSQL's own parser, so that the rules understand exactly the SQL PostgreSQL does.
31. As a developer, I want the rules to be an allowlist, so that unfamiliar or newer syntax is refused rather than slipping through.
32. As a developer, I want the generated schema change checked by the same rules as my scripts, so that a differ bug can't bypass them.
33. As a developer, I want statements that can't run in a transaction (`CONCURRENTLY`, `VACUUM`, database and tablespace commands, and so on) refused, so that a deployment can never break its own transaction.
34. As a developer, I want transaction control (`BEGIN`, `COMMIT`, `ROLLBACK`, savepoints), `CALL` and `DO` refused in scripts, so that nothing silently ends the deploy transaction.
35. As a developer, I want calls to built-ins whose effects escape a rollback (such as `setval`, `pg_notify`, advisory locks, file and signal functions) refused, so that a failed deployment leaves no trace.
36. As a developer, I want volatile functions like `now()` and `gen_random_uuid()` allowed, so that backfills can set timestamps and keys.
37. As a developer, I want column-order-dependent SQL (`INSERT` without columns, `SELECT *`, ordinal `ORDER BY`/`GROUP BY`, `NATURAL JOIN`, whole-row references, `COPY`) refused, so that scripts behave the same whatever physical column order a target has.
38. As a developer, I want explicit values into identity columns refused, so that sequences never fall behind and collide.
39. As a developer, I want enums, partitioning, extensions other than `plpgsql`, `serial` columns, `NOT ENFORCED` constraints, virtual generated columns and other unsupported object types refused with a clear reason, so that I know V1's limits up front.
40. As a developer, I want every index and constraint to require an explicit name, so that names never depend on load order.
41. As a developer, I want PL/pgSQL bodies checked for dynamic SQL, transaction control and denylisted calls, so that routines can't smuggle in what scripts are forbidden.
42. As a developer, I want to override super-deploy's refusal of a single statement with `-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>` on the line before it, so that a justified exception is possible but always visible.
43. As a reviewer, I want every override listed in the migration's metadata, `finalize` output and `validate` report, so that exceptions are never hidden.
44. As a developer, I want overrides to be impossible for transaction-breaking rules, so that the core guarantee can't be overridden.
45. As a developer, I want PL/pgSQL routines to reference declared external schemas that rehearsals don't contain, so that loader routines can read other parts of the database.
46. As a developer, I want references to undeclared schemas refused, so that typos in schema names are caught.
47. As a developer, I want every rule violation to name the file, line, statement and rule, so that I can fix it without guessing.

### Integrity and review

48. As a reviewer, I want each finalized migration's files hashed and chained to the previous one, so that any edit to history is detectable.
49. As a developer, I want hashes to be identical on Windows, macOS and Linux regardless of line endings, so that teams on mixed platforms don't get false failures.
50. As a team lead, I want the pre-commit hook to run `validate --strict`, so that tampered or unchecked migrations can't be committed.
51. As a developer, I want `validate` to warn about an unfinalized draft and undrafted desired-schema changes, so that I don't forget work in progress.
52. As a developer, I want finalized migrations and generated schema changes read-only in my editor, so that I don't edit them by accident.

### Deploying

53. As a release engineer, I want `status --target X` to show pending migrations, drift, the disposable flag and recent attempts, so that I know what a deployment will do.
54. As an operator, I want `status` to exit non-zero on drift, when drift couldn't be checked, and when a deployment would refuse, so that a scheduled job alerts us and a pipeline can gate `deploy` on it.
55. As a release engineer, I want `deploy --target X` to apply every pending migration in one transaction, so that the target ends at the newest migration or exactly where it started.
56. As a release engineer, I want a deployment to refuse when the target has drifted from its recorded migrations, so that we never build on an unknown structure.
57. As a release engineer, I want every deployment rehearsed on a throwaway database matching the target's encoding, locale and collation provider, so that collation differences can't surprise production.
58. As a release engineer, I want a second deployment to the same target to fail immediately and name the attempt holding the lock, so that concurrent deployments can't collide.
59. As a release engineer, I want per-target lock and statement timeouts, so that a deployment fails fast instead of queueing behind application traffic.
60. As a release engineer, I want session settings (search path, time zone, date styles) pinned identically in rehearsals and deployments, so that results don't depend on server defaults.
61. As a release engineer, I want deferred constraints checked at each migration boundary, so that a failure names the migration that caused it.
62. As a release engineer, I want errors to name the file that failed, so that I know where to look.
63. As an auditor, I want every deployment attempt recorded even when it fails, so that failures are never invisible.
64. As a release engineer, I want an attempt whose COMMIT outcome was lost to be settled automatically on the next `status` or `deploy`, so that we always know whether it landed.
65. As a release engineer, I want deployments to refuse when the managed schema or anything in it is owned by a role the deploy role isn't a member of, listing each object with the `ALTER ... OWNER TO` that fixes it, so that a deployment can't fail with "must be owner" partway through.
67. As a security reviewer, I want a warning when the deploy role is superuser or holds server-file or signal privileges, so that we can tighten it.
68. As a release engineer, I want the history schema created automatically by the first deployment, so that a new target needs no manual setup.
69. As an operator, I want to choose the history schema's name, so that it fits our database conventions.
70. As a release engineer, I want Ctrl+C or SIGTERM during a deployment to roll back, release the lock, record the attempt as abandoned and clean up throwaway databases, so that interruption is always safe.

### Recovering

71. As a release engineer, I want to retry a failed deployment after fixing its cause, so that transient problems have a simple fix.
72. As a developer, I want to create a Recovery that replaces a failed migration's scripts and seed data for targets that haven't run it, so that a migration that can't succeed on real data can be fixed without editing history.
73. As a developer, I want a Recovery to be refused if it would change the migration's structural result, so that every target that records the migration has the same structure.
74. As an auditor, I want each target's history to say whether it ran a migration's original scripts or a specific Recovery, so that data differences can be explained.
75. As a DBA, I want to `mark` the next pending migration as deployed after fixing a target by hand, but only if the target's structure matches a replica exactly, so that manual fixes can't hide drift.
76. As a DBA, I want marks recorded only on the target, under my OS username, so that the repo stays shared and the action is attributable.

### Disposable targets

77. As a developer, I want to flag a target as disposable from inside its own database, so that editing the config can never make production disposable.
78. As a developer, I want `deploy-draft` to try my unfinalized draft on a disposable target, so that I can test against realistic data before finalizing.
79. As a developer, I want seed data loaded by `deploy-draft` only when I opt in, so that I don't overwrite other experiments on the target.
80. As a developer, I want `rebuild --to N` to wipe a disposable target and replay migrations up to N, so that I can reset to a known point. Objects in other schemas that depend on the managed schema's objects are dropped with them, and the confirmation lists each of them first.
81. As a team lead, I want `mark`, `rebuild`, `deploy-draft` and `disposable` to require typing `YES` at a real terminal after showing the target's details, and never run in CI, so that destructive manual actions can't happen by accident or automation.

### Starting a project

82. As a developer, I want `init` to scaffold a working project with a local embedded PostgreSQL, so that I can start without any external database.
83. As a developer, I want `init --adopt <target>` to turn an existing database's managed schema into migration 1 and record it as deployed there, so that I can bring existing systems under management.
84. As a developer, I want adoption refused with a full list of unsupported objects, so that I know exactly what to change first.
85. As a developer, I want the template to tell me that seed data must be synthetic or anonymised, so that production data doesn't end up in git.

### Running the tool

86. As a developer, I want an interactive menu grouped by task when I run the tool with no arguments, so that I don't need to memorise commands.
87. As a developer, I want the menu to return to the command I just ran, so that I can run several in a row.
88. As a CI pipeline, I want every command runnable with flags and never prompting without a terminal, so that automation behaves the same every time.
89. As a CI pipeline, I want distinct exit codes for failure, usage errors and each kind of interruption, so that pipelines can react correctly.
90. As a developer, I want results on stdout and warnings and progress on stderr, so that output can be piped cleanly.
91. As a developer, I want one-line errors by default and `--debug` for stack traces, so that output stays readable.
92. As a developer, I want commands to find the project from any subdirectory, so that I don't have to `cd` to the root.
93. As an integrator, I want every command available as a typed function with callbacks for questions and typed errors, so that I can embed the tool in my own scripts.
94. As an integrator, I want to supply my own adapters for connecting to targets and providing throwaway databases, so that the tool works with my secrets manager, IAM tokens, tunnels or CI servers.
95. As an integrator, I want commands to connect only to the targets they touch, so that a command that doesn't touch production never needs its credentials.
96. As a developer, I want the tool to refuse a server that isn't PostgreSQL 18, so that rehearsals and targets always match.
97. As a contributor, I want the repo's scripts to be TypeScript run by pnpm and the CI to run on Windows, macOS and Linux, so that the tool works the same everywhere.
98. As a DBA, I want grants, default privileges, policies and row-level security I set up on a target by hand never compared, reset or counted as drift, so that I can give the application's roles access the way each target needs.
99. As a developer, I want a grant, policy or `SECURITY DEFINER` routine refused in every file super-deploy deploys, saying that privileges and row-level security are set up on targets outside super-deploy, so that I know where they belong.
100. As a developer, I want `init --adopt` to ask me for a reason for each statement that needs an override marker (usually a function), so that I can adopt a database that uses dynamic SQL without first removing those functions from it.

## Implementation Decisions

### Guarantees

- **Structural determinism** (Q2): deployments run only frozen SQL; the differ never runs at deploy time; the same migrations from the same starting structure always produce the same structure, verified by rehearsal and drift checks. Data is not required to be deterministic (Q41).
- **All-or-nothing** (ADR-0001): every pending migration in one transaction, no escape hatch, no savepoints, no automatic retry.
- **Immutability** (Q10, Q36): finalized migrations never change; a Recovery supersedes scripts without editing them.

### Modules

**Project and configuration** (Q56, Q59)
- A typed `super-deploy.config.ts` at the project root, found by walking up from the working directory, loaded with Node's built-in TypeScript support (no `enum`/`namespace`).
- Settings: `postgresVersion` (required, must be 18), `rehearsal` adapter (required), `targets` (each: deployment adapter, `lockTimeout` default 5s, optional `statementTimeout`, `connectTimeout` default 10s), `managedSchema` (default `public`), `historySchema` (default `deployment_history`), `externalSchemas` (default none), `directory` (default `data-model`).
- Never in config: credentials, the disposable flag, migration state.

**Adapters** (Q19, consumer-implemented interfaces)
- Deployment adapter, per target: opens a session that runs SQL, runs queries, reports its server version and closes. Called only when a command connects. `deploy` opens two sessions: one for the transaction, one for the attempt log.
- Rehearsal adapter, per project: creates an empty throwaway PostgreSQL 18 database with a requested encoding, locale and collation provider, and drops it afterwards. Its login needs `CREATEDB`, never `CREATEROLE`: rehearsals create no roles.
- The library ships node-postgres adapters configured from a connection string or environment variable. The template ships an `embedded-postgres` adapter and runs two servers with it: one for the `dev` target, on a port the config declares so users and their applications can connect to `dev` at a known URL, and one for rehearsal databases on a free port, so `dev` is a database on a server of its own like a real target.
- The library validates what adapters return (e.g. refuses a server that isn't PostgreSQL 18).

**SQL analysis** (ADR-0002, ADR-0004; database-free)
- Built on `libpg-query@18` and `@pgsql/types`, pinned exactly; PL/pgSQL bodies parsed with its PL/pgSQL parser (Q18, Q29).
- One splitter and syntax-tree walker shared by two capabilities:
  - **Rules**: given SQL and its file kind (desired schema, schema change, pre-migration, post-migration, seed), return violations with file, line, statement and rule; plus destructive statements, rewrite/scan warnings and overrides found.
  - **Ordering**: given the desired-schema files, return an ordered list of statements or errors (unknown references, cycles) with file and line.
- Override markers are read from the raw text between statements, because PG18's parser excludes leading comments from statement locations.

**Rules: desired schema** (Q5, Q8, Q22, Q28, Q31, Q35, Q40, Q48, Q49, Q65, Q67)
- Allowed: `CREATE` of supported object types; `COMMENT ON`; exactly `ALTER TABLE … ADD CONSTRAINT`; `CREATE EXTENSION plpgsql`.
- Supported object types: tables (with stored generated columns), primary key, foreign key, unique, check, exclusion and NOT NULL constraints, indexes, views, materialized views, identity columns, functions, procedures, triggers, domains, composite types, comments.
- Refused: enums; partitioned tables; extensions other than `plpgsql`; rules; event triggers; foreign tables and foreign data wrappers; publications and subscriptions; custom casts, operators, aggregates, collations and text-search configurations; standalone sequences; `CREATE STATISTICS`; `serial`/`bigserial`; `NOT ENFORCED` constraints; `VIRTUAL` generated columns (including PG18's keyword-less default).
- Also refused in V1: temporary tables and views; table inheritance and typed tables; range and base types; procedural languages and routines in languages other than `sql` and `plpgsql`; routine options other than language, volatility, `STRICT`, `SECURITY INVOKER`, `LEAKPROOF`, parallel, cost, rows and `SET`; view options other than `security_invoker`, `security_barrier` and `check_option`; custom conversions, transforms and access methods; physical storage settings (unlogged tables, tablespaces, table storage parameters, table access methods, column `STORAGE` and `COMPRESSION`); comments on view and materialized-view columns, which the differ doesn't generate (QA 127), and which adoption refuses on a target too.
- Privileges refused (ADR-0006), as structural rules no override marker bypasses: `GRANT`; `REVOKE`; `ALTER DEFAULT PRIVILEGES`; role statements and role membership; `OWNER TO`, `REASSIGN OWNED` and `DROP OWNED`; `CREATE`, `ALTER` and `DROP POLICY`; `ALTER TABLE … ENABLE/DISABLE/FORCE/NO FORCE ROW LEVEL SECURITY`; the `SECURITY DEFINER` routine option. Each message says privileges and row-level security are set up on targets outside super-deploy.
- Refused because no load order could make them deterministic: `IF NOT EXISTS` and `OR REPLACE` (each object is defined exactly once, and the desired schema always loads into an empty schema, so these clauses can only hide a second definition); unnamed indexes and constraints; a foreign key whose referenced columns are covered by more than one unique index or constraint; function calls written in column syntax.
- Objects live in the managed schema and may reference only `pg_catalog`, except that PL/pgSQL bodies may reference declared external schemas. Objects that bind references at `CREATE` (views, defaults, foreign keys, triggers, `LANGUAGE sql` and `BEGIN ATOMIC` bodies) cannot reference external schemas, because rehearsals don't contain them. `check_function_bodies` stays on.

**Rules: deploy-time SQL** (Q1, Q4, Q6, Q7, Q12, Q16, Q40, Q41, Q42, Q44, Q45, Q47)
- Applies to generated schema changes, pre-migration scripts, post-migration scripts and seed data.
- Never allowed: anything PostgreSQL refuses in a transaction block; transaction control; `CALL`; `DO`. The full catalogue is in `research/transactional-hazards.md`.
- Functions: only `pg_catalog`, minus a denylist of built-ins whose effects escape the transaction. User-defined functions may not be called directly; triggers firing from DML is accepted. Volatile built-ins are allowed.
- Column-order-dependent constructs are refused, as are explicit values into identity columns.
- DML: `INSERT` with a column list, `UPDATE`, `MERGE` allowed; `DELETE` and `TRUNCATE` allowed but destructive; `CREATE TEMP TABLE … ON COMMIT DROP` (including `AS SELECT`) allowed; other temp tables, permanent `CREATE TABLE AS`/`SELECT INTO`, `COPY` and standalone `SELECT` refused.
- Other statements: `SET`, `RESET`, `SET CONSTRAINTS`, `LISTEN`, `NOTIFY`, `PREPARE`, `DECLARE`, `LOAD` refused; `COMMENT` refused in scripts (the desired schema owns comments); the privilege statements the desired schema refuses are refused in every deploy-time file, generated schema changes included; `LOCK TABLE`, `ANALYZE` and non-concurrent `REFRESH MATERIALIZED VIEW` allowed.
- References: only the managed schema, the script's own temp tables, and `pg_catalog` for reading.
- Per file kind: pre-migration scripts may use DDL and DML; post-migration scripts DML only; seed data `INSERT` with column lists only.

**Rules: PL/pgSQL bodies** (Q29): refuse `EXECUTE`, `COMMIT`/`ROLLBACK`, denylisted calls and references to undeclared schemas.

**Override marker** (Q24, Q30): `-- OVERRIDE SUPER-DEPLOY REFUSAL: <reason>` on the line before one statement, reason required. Recorded by object identity so it survives regeneration. Only risk rules (dynamic SQL, denylisted functions) can be overridden, never transaction-breaking rules. Every override appears in migration metadata, `finalize` output and `validate`.

**Destructive changes and warnings** (Q25, Q46): drops, column drops, lossy type changes, `DELETE` and `TRUNCATE` need acknowledgement at `finalize`, recorded in metadata. Rewrites and full scans of existing tables (type changes, volatile defaults, `SET NOT NULL`, constraint validation, `CREATE INDEX`, `TRUNCATE`) produce warnings; tables created in the same migration are exempt.

**Desired-schema loading** (Q35, ADR-0004)
- Statements, not files, ordered by object-kind priority and dependencies, ties broken only by object identity and a hash of the statement text, never file path or locale.
- Models every reference shape PostgreSQL binds at `CREATE`, including `BEGIN ATOMIC` bodies, unqualified names in `LANGUAGE sql` bodies, argument defaults, trigger `WHEN`, composite type attributes, `%TYPE`, `::regclass`, and implicit `_pkey`/`_seq` names. PL/pgSQL bodies are ignored for ordering. A call waits for every overload of its function name. Circular foreign keys are closed with `ALTER TABLE … ADD CONSTRAINT`.
- Order-independence check during `draft`, `rehearse` and `finalize`: load again in a different valid order and compare catalogs, including what each view, default and function body is bound to. Any difference fails, naming the objects.
- Prototype: `prototype/schema-ordering` (`25d5c18`) proved the approach at about 600 lines and 0.3 s for 5,000 statements; the production version is estimated at about 2k lines plus 60–100 fixtures.

**Differ** (Q3, Q17, ADR-0003)
- The desired schema is read by loading it into a throwaway database and reading the catalogs; SQL is never modelled by parsing.
- Behind our own `Differ` interface. V1 wraps `@supabase/pg-delta`, pinned to exactly `1.0.0-alpha.59`, calling its extract and plan operations directly. Its directory loader and `@supabase/pg-topo` are never used. Every upgrade re-runs the prototype. Fallback: our own `pg_catalog`/`pg_depend` differ behind the same interface.
- Table column order is never a difference, but a composite type's attribute order is (its values are built by position); ownership is not diffed, and neither are grants, default privileges, policies or row-level security flags: pg-delta's plan excludes ACLs, default privileges and policies, our wrapper clears every table's RLS flags before planning, and our catalog comparison reads none of them, so a schema change never contains them and they are never drift (ADR-0006).
- Verification, independent of engine: apply the generated migration to a fresh database, read it back, and require an empty diff against the desired schema using both pg-delta and our own `pg_catalog` comparison (pg-delta's own re-diff misses some of its errors).
- Known pg-delta gaps (prototype `prototype/pg-delta`, `9d619fe`): `BETWEEN` in a check never converges (upstream #544, tracked); PG18 NOT NULL constraint names and comments on constraint-backed indexes are lost (our catalog comparison must catch these); changing an in-use domain's base type is refused.

**Rehearsal** (Q19, Q20, Q23, Q66)
- Throwaway databases match the requested encoding, locale and collation provider; deployments match the target's.
- Rehearsals create no roles.
- Session settings are pinned identically to deployments.
- A draft rehearsal replays every finalized migration (newest variant), loads the draft's seed data, runs pre-migration script → schema change → post-migration script, then requires an empty diff against the desired schema.

**Migration store** (Q33, Q34, Q36, Q39)
- Project directory holds the desired schema, one draft, and the finalized migrations with a hash-chain index. Each migration folder holds its pre-migration script, schema change, post-migration script, seed data, metadata and a snapshot of the desired schema at finalize. Recoveries live under their migration.
- One draft at a time: normal or Recovery, never both (Q50).
- Folder names: five-digit zero-padded number, hyphen, kebab-case description of at most 60 characters. Input is trimmed, lowercased, space runs collapsed to one hyphen, and any other invalid character refused with the result previewed. The number is the identity; the hash covers the folder name.
- Hashing: UTF-8 (BOM refused), line endings normalised to LF, SHA-256 over every file and the folder name; `chain[n] = sha256(chain[n-1] + content_hash[n])`.
- Finalized files are made read-only (works on Windows too). The template ships `.gitattributes` forcing LF for SQL and JSON.
- Metadata: tool, differ and parser versions; rehearsal server version; destructive acknowledgement with its statements; overrides with reasons and object identities. No timestamps or usernames.

**Authoring commands** (Q16, Q25, Q27)
- `draft`: load the desired schema into one throwaway database; replay migrations, the draft's seed data and its pre-migration script into another; diff the second to the first; write the schema change; report what scripts must cover. It then checks its output: it runs the schema change once on that starting point and compares the result with the desired schema as a rehearsal does, warning (and still writing the draft) when PostgreSQL refuses it or it doesn't produce the desired schema, naming the cause (QA 102). Recovery drafts never regenerate the schema change.
- `rehearse`, `finalize`, `unfinalize`, `restore-schema`, `discard-draft`, `validate [--strict]` as described in the user stories.

**Recoveries** (Q10, Q13): replace pre-migration script, post-migration script and seed data, never the schema change. Newest Recovery wins for targets that haven't recorded the migration. Rehearsal proves the original and every Recovery end in identical structure.

**Seed data** (Q11, Q14, Q15, Q27): belongs to one migration or Recovery and is frozen with it as an audit record. Loaded only in rehearsals of its own draft (including `finalize`'s) and by `deploy-draft --with-seed`. Never loaded when finalized migrations are replayed, in deployment rehearsals, by `rebuild`, or on any non-disposable target.

**Deployment engine and history schema** (Q20, Q21, Q24, Q28, Q32, Q37, Q38, Q53, Q54, Q55, Q66)
- History schema, created by the first deployment inside its transaction, with three tables:
  - migrations: number, name, variant (original or Recovery K), content and chain hashes, attempt id, how recorded (deployed or marked). Written inside the deploy transaction.
  - attempts: command, target, migration range, OS username, tool version, start and end time, outcome (running, succeeded, failed, abandoned, unknown), error. Written on a second connection outside the transaction.
  - settings: the disposable flag; new targets are not disposable.
- A schema with the history schema's name that a DBA created beforehand, empty and owned by the deploy role (or a role it has the privileges of), gets the tables instead, so the deploy role needs no `CREATE` on the database. Any other schema of that name that super-deploy didn't make is refused by every command that records on the target, and listed by `status` as a refusal, naming the schema and what it holds (or its owner), with the ways out: drop it, or set `historySchema` to another name.
- Locking: a session-level advisory lock taken with try-lock on the command's own connection, keyed from the history schema name, by `deploy`, `mark`, `rebuild`, `deploy-draft` and `disposable`. Contention fails immediately, naming the holding attempt and its server process with its `pg_stat_activity` state, statement and statement start, and saying that `select pg_terminate_backend(<pid>)` ends its session, and so releases the lock, if the command is known to be dead (`pg_cancel_backend` would end only the statement, and the session keeps a session-level lock). Every target session sets `client_connection_check_interval` to 5 s (where the server's platform supports it), so a statement whose CLI died ends within seconds rather than running to its end.
- `status` takes no lock. While another command holds the target lock, it names the holder (attempt, command, user, start time, server process and what it is running) and reports drift as not checked, since the holder's transaction would block the catalog read; like any unchecked drift, that makes it exit 1.
- `deploy` sequence: open attempt → lock → pre-flight (the ownership check, that the deploy role owns the managed schema and everything in it or is a member of their owner; deploy-role privilege warning; a warning for each object the pending migrations drop and recreate whose grants, revokes, policies or row-level security on the target the deploy role's default privileges won't give back; recorded hashes match the repo; declared external schemas are not checked, since the DBA sets them up) → drift check (replay the target's recorded migrations, each with its recorded variant, on a locale-matched throwaway database; any structural difference refuses, no exceptions) → rehearse the pending migrations on that database (newest Recovery where one exists) and require a match with the newest snapshot → one transaction on the target → close attempt.
- Inside the transaction: `SET LOCAL` search path (managed schema, then `pg_catalog`), time zone UTC, fixed date and interval styles, the target's lock and statement timeouts. Per migration: pre-migration script, schema change, post-migration script, each as its own batch so errors name the file, with `SET CONSTRAINTS ALL IMMEDIATE` at each migration boundary.
- Target setup that stays outside super-deploy: the deploy role, which owns the managed schema and everything in it (or is a member of their owner) and has `CREATE` on the database for the first deployment (or the history schema created beforehand, empty and owned by it); the application's roles, their membership and database-level privileges (`CONNECT`, `TEMPORARY`); the application's grants and any policies, recommended through `ALTER DEFAULT PRIVILEGES FOR ROLE <deploy role> IN SCHEMA <schema> GRANT …`, which is not drift (a role that refreshes materialized views needs `MAINTAIN` on them), plus a global `ALTER DEFAULT PRIVILEGES FOR ROLE <deploy role> REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` (without `IN SCHEMA`, since per-schema default privileges only add) because functions and procedures are callable by `PUBLIC` by default; external schemas, which super-deploy doesn't check (a routine that reads a missing one fails only when it runs), and grants on them and their objects, to the application's roles, since routines run as their caller. A migration's scripts and seed data can't fire a trigger or call anything that reads an external schema, since rehearsals don't contain them; a script failing in a rehearsal on a missing object in a declared external schema says so. A migration that drops and recreates an object (a function, when its arguments or return type change) loses the grants, revokes and policies made on it by hand, so a lost revoke widens access; `status`, `deploy` and `deploy-draft` warn about each such object, naming what default privileges won't give back; only objects a statement drops by name are warned about, not what a hand-written `DROP ... CASCADE` takes with it. One that changes the type of, or drops, a column a hand-made policy uses fails at deploy, which rehearsals can't catch: drop the policy, deploy, then create it again. The same goes for objects in other schemas that depend on managed ones (a view, a foreign key, a column of a managed type): rehearsals don't have them, so a migration that changes or drops what they use fails at deploy; `init --adopt` names those the target has. Every object belongs to the deploy role, and row-level security doesn't apply to a table's owner: a view over a table with policies shows every row unless it is declared `with (security_invoker = true)`, and a materialized view, built and refreshed as the deploy role, holds every row whatever the policies. Rehearsals and deployments pin `row_security` off, so on a table with `FORCE ROW LEVEL SECURITY` a statement or materialized view a policy would filter fails the deployment instead of silently skipping rows; the error suggests `NO FORCE ROW LEVEL SECURITY` while deploying.
- Unknown COMMIT outcome: recorded as unknown, settled on the next `status` or `deploy` by checking the migrations rows written inside the transaction.

**Guarded and recovery commands** (Q14, Q27, Q52)
- `mark`: next pending migration only; refuses before asking `YES` when the deploy role doesn't own what's in the managed schema (the pre-flight's ownership check); builds a locale-matched replica of migrations up to N and requires an empty diff (table column order and ownership ignored); records the original variant; writes only to the target's history schema.
- `disposable --set yes|no`, `deploy-draft [--with-seed]` (disposable targets only), `rebuild --to N` (disposable only, no seed data; drops everything in the managed schema, taking the grants and policies on those objects with it, and leaves the schema itself, its grants and its default privileges as they are; with `CASCADE`, so it also drops the objects in other schemas that depend on them, which its confirmation lists first; refuses before asking when the managed schema holds something the deploy role can't drop).
- Guard sequence: refuse in CI or without a terminal on stdin and stdout; check preconditions; show the action plus the target's name, host, database and last recorded migration; require typing `YES` exactly; record a manual attempt under the OS username. Nothing skips it.

**`init`** (Q51): scaffolds from the template bundled in the library package. `--adopt <target>` generates desired-schema files from the target's managed schema, creates migration `00001-adopt`, records it on the target as marked using `mark`'s check, and refuses with a full list if anything V1 refuses is present, `SECURITY DEFINER` routines included. Grants, policies and row-level security flags on the target are left out of the desired schema, with one line saying how many grants and policies were left as they are, and, when there are any, how many tables have row-level security enabled (and forced) and how many default-privilege rules the deploy role has in the managed schema or globally. Everything that can be found without writing is refused at once, in one list: what V1 refuses, each object that fails the ownership check (with its fix, unless it is refused as unsupported anyway), a schema with the history schema's name that super-deploy didn't make and can't use, and the deploy role lacking CREATE on the database for the history schema; nothing is written. A target without the managed schema is refused on its own, before that list, listing the schemas it has: without the schema there is no ownership to check and nothing to adopt. Statements that break only risk rules (usually functions using dynamic SQL) are not refused when a reason is given: once nothing else is refused, adoption asks for one per statement in a terminal (or through a callback in the API) and writes the marker with it; while something else is refused, the refusal names them as the ones reasons will be asked for; without a terminal it refuses them, listing them.

**CLI shell and programmatic API** (Q50, Q57)
- One set of command definitions drives both `util.parseArgs` flags and an `@clack/prompts` menu grouped into Start, Author, Deploy, Recover and Disposable sections. No `setup` command.
- Option kinds: target (from config), migration number (searchable, newest first), choice, name (normalised), flag. The menu never sets acknowledgement flags; commands ask yes/no (default no) when it matters, and refuse without the flag when there's no terminal.
- Unknown, repeated, missing or invalid options are usage errors and nothing runs.
- Exit codes: 0 success; 1 failed or refused (and `status` unless the target is deployable with no drift: 1 on drift, on drift not checked, or on anything a deployment would refuse; pending migrations alone exit 0); 2 usage error; 129 SIGHUP; 130 SIGINT; 141 closed output; 143 SIGTERM.
- Interruption: roll back, release the lock, mark the attempt abandoned, drop throwaway databases, print one notice (none for closed output), then, once cleanup has finished, one line on what happened to the target for commands that change one (rolled back and still at its last recorded migration, already finished, or unknown); a second interrupt exits at once, unless it repeats the first signal within about a second (one interruption delivered twice, e.g. by the terminal and by `pnpm exec`) or is SIGHUP. An interruption after the command has finished (while the CLI closes the project) keeps the command's own exit code, and its notice says the command had finished.
- Every command is also an exported function taking a loaded project, with flags as options, questions as callbacks, and typed errors. Guarded commands stay terminal-only.

**Repo and tooling** (Q58–Q63)
- pnpm workspace with three packages: the library and CLI, an example project, and the template `init` copies (bundled into the library's build). Every cross-package script runs as `pnpm -r <script>`.
- Node ≥ 24, ESM only, strict TypeScript built with plain `tsc`. Repo scripts are TypeScript run by Node, never shell scripts.
- Biome for TypeScript and JSON; the Postgres Language Server recommended for in-editor SQL diagnostics; no automatic SQL formatting.
- Husky runs `pnpm precommit`: the library runs Biome check, typecheck and unit tests; the example and template run Biome check, typecheck and `validate --strict`.
- VS Code multi-root workspace, each folder with its own settings; format via a run-on-save extension calling the nearest package's formatter; the template marks finalized migrations and generated schema changes read-only.

## Testing Decisions

### What makes a good test

- Tests exercise external behaviour only: what a user or integrator can observe. They never assert on internal modules, data structures or call sequences.
- Tests use real PostgreSQL 18, not mocks. Faults are injected by wrapping a real adapter session, never by mocking internals.
- Tests are written first, one red-green slice at a time.

### Seams (agreed with the user)

1. **Programmatic API against a real project folder and real PostgreSQL 18 (main seam).** A test creates a temporary project with a config and desired-schema files, wired to `embedded-postgres` throwaway databases and targets through the real adapters, then calls the exported command functions, answering questions through callbacks. Assertions cover only observable results: files written, hashes and read-only state, the target's managed and history schemas, and typed errors. This covers authoring, rehearsal, drift, deployment, Recoveries, `mark`, disposable targets and adoption. The differ, hash chain and history tables are tested only through this seam.
2. **CLI process (thin).** Spawn the real binary to test only what exists at the process boundary: flag parsing and usage errors, exit codes, stdout/stderr separation, SIGINT/SIGTERM/closed-pipe cleanup, and guarded commands refusing without a terminal or in CI.
3. **SQL analysis (database-free).** Pure functions taking SQL text and file kind, returning violations or a load order. Hosts the high-volume fixture suites and runs in the library's pre-commit.

Fault injection (lost COMMIT outcome, lock contention, a script failing midway) uses a wrapper around a real adapter session at the existing adapter seam.

### What is tested where

- **SQL analysis:** at least one refused fixture for every hazard in `research/transactional-hazards.md`, an allowed fixture for every allowed statement form, every refused object type, every override case, and 60–100 ordering fixtures including every case from both ordering spikes. Ordering fixtures assert the order is unchanged when files are renamed and statement order reversed.
- **Programmatic API:** happy-path authoring through deployment; destructive acknowledgement; rehearsal mismatch; order-independence failure; drift refusal; lock contention; script failure with full rollback and the attempt still recorded; unknown COMMIT outcome settled; Recovery deployment and variant recording; `mark` with matching and mismatching replicas; disposable flag enforcement; `deploy-draft` with and without seed data; `rebuild`; `init` and `--adopt` (including refusal); a missing external schema refusing nothing; objects the deploy role doesn't own; hand-made grants, default privileges and policies that are not drift and survive `deploy` and `rebuild`; `validate` detecting edits, renamed folders and CRLF-only changes.
- **CLI process:** every exit code, usage errors, interruption cleanup, guarded-command refusal without a terminal.
- **CI:** GitHub Actions on Ubuntu, macOS and Windows with Node 24. Integration tests run in CI; the library's pre-commit runs only database-free tests.

### Prior art

There is no production code yet. Reusable prior art from the prototype branches (not merged to main):
- `prototype/pg-delta` (`9d619fe`): embedded-postgres PG18 harness, catalog snapshot comparison, and 90 create/alter/drop round-trip scenarios across every supported object type: the starting point for the differ verification and the API seam's harness.
- `prototype/schema-ordering` (`25d5c18`): ordering proof-of-concept, ordering fixtures, and the order-independence check.
- `prototype/pg-topo-pg18` (`7f91fd6`): a 28-case matrix of V1-supported reference shapes, useful as extra ordering fixtures.

## Out of Scope

Everything recorded in `REFINEMENTS.md`, including: calling user-defined functions or procedures in scripts; enums; non-transactional operations and out-of-band index builds; tolerating drift; a Recovery replacing the schema change; seed data that persists across rehearsals; extensions other than `plpgsql`; partitioned tables; virtual generated columns; other refused object types; assertion directives; size-aware lock warnings; proving (rather than sampling) order independence; automatic SQL formatting; managing roles, ownership, grants, default privileges, policies and row-level security; `SECURITY DEFINER` routines; publishing to npm.

Also out of scope: managing more than one schema; PostgreSQL versions other than 18; creating or dropping roles on targets.

## Further Notes

- The pg-delta prototype was run on Linux only. Windows behaviour of `embedded-postgres` and pg-delta is unverified until CI runs there; treat the first Windows CI run as a risk.
- pg-delta is an alpha with 60 releases including a full rewrite; the pinned version must not float, and any upgrade re-runs the prototype scenarios.
- pg-delta's licence is the PostgreSQL licence (not MIT as `research/parsers-and-differs.md` states).
- Tickets: `.scratch/super-deploy/issues/`, 23 tracer-bullet slices. 01 is the repo scaffold; 02→03→04 is the first end-to-end path (draft, finalize, deploy one table); the rest widen it.
