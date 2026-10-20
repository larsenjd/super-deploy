# Refinements

Decisions made deliberately narrow for V1, to reconsider or review once V1 ships. Each entry records what V1 does, why, and what would justify revisiting it.

## Calling functions and procedures in deploy-time SQL

**V1:** Deploy-time SQL may not `CALL` procedures, run `DO` blocks, or call any function outside `pg_catalog`. Built-in functions are allowed except a denylist of ones with effects that escape the transaction (e.g. `setval`, `pg_notify`, advisory locks, `dblink*`, `lo_export`, signal/admin functions). Defining functions, procedures and triggers in the desired schema is allowed. Triggers firing from DML in scripts is accepted and documented.

**Why narrow:** A procedure that commits ends the deploy transaction; a function can cause effects a rollback cannot undo. The parser cannot see inside routine bodies.

**Revisit when:** Real projects need to reuse logic in scripts (e.g. a backfill function). Options: allow calling functions declared in the desired schema whose bodies pass the same rules, or allow only `IMMUTABLE`/`STABLE` user functions. Name-based matching also misses operators, casts and defaults, so consider pairing the parser with a restricted deploy role as a backstop.

**Research:** `.scratch/super-deploy/research/transactional-hazards.md` §2, §4, open questions 4–5.

## Enums

**V1:** Enum types are banned in both the desired schema and deploy-time SQL. Use a lookup table with a foreign key, or a `CHECK` constraint.

**Why narrow:** A value added with `ALTER TYPE ... ADD VALUE` cannot be used until commit, and every pending migration runs in one transaction, so adding a value in one migration and using it in a later pending one always fails. PG18 exempts enums created in the same transaction, but only at top level (not inside savepoints), which is too fragile to rely on.

**Revisit when:** There is demand for enums. Options: allow creating enums but never altering them (new values mean a new type), or allow `ADD VALUE` only when no later pending migration uses the value.

**Research:** `.scratch/super-deploy/research/transactional-hazards.md` §3.

## Operations that cannot run in a transaction

**V1:** No escape hatch. Every pending migration runs in one transaction, so `CREATE/DROP/REINDEX ... CONCURRENTLY`, `DETACH PARTITION CONCURRENTLY`, `VACUUM` and similar are banned. Building indexes out-of-band (e.g. `CREATE INDEX CONCURRENTLY` by hand ahead of a deployment) is not a supported workflow either: it shows up as drift and the deployment refuses. An index on a large existing table is built by the deployment and blocks writes to that table until commit; V1 accepts that.

**Why narrow:** The all-or-nothing deployment is the core guarantee. A non-transactional phase breaks it.

**Revisit when:** Out-of-band work becomes routine. Options: a separately committed phase before or after the main transaction, with its own history record and recovery story.

**Research:** `.scratch/super-deploy/research/transactional-hazards.md` §1, §5, open question 1.

## Recoveries replacing the schema change

**V1:** A Recovery replaces only a migration's pre-migration script, post-migration script and seed data. The schema change is never replaced, so the original and every Recovery must end in structurally identical results.

**Why narrow:** Keeping the schema change fixed means every target that records a migration has the same structure, whichever variant it ran.

**Revisit when:** A failed migration's schema change itself is the cause (e.g. a generated statement that cannot succeed on real data). Allowing a replacement would need a rule for what "the same migration" means when targets end in different structures.

## Seed data that persists across rehearsals

**V1:** Seed data exists only for the rehearsal of the migration it belongs to. It loads just before that migration's pre-migration script and is gone afterwards. It is not replayed when later migrations are rehearsed.

**Why narrow:** Seed data is for troubleshooting a specific problem, not a regression suite. A growing data set makes every later migration answer to old data.

**Revisit when:** The same data problems recur, or teams want proof that later migrations still handle earlier problem data. Option: an opt-in, ongoing seed data set that every rehearsal replays.

## The differ engine

**V1:** The differ sits behind our own interface. The V1 implementation wraps `@supabase/pg-delta`, pinned to an exact version, after a short prototype confirms it fits our rules (notably that column order is not a difference). Every migration is verified independently: apply it to a fresh database, read the schema back, require an empty diff against the desired schema. Each migration records which differ and version generated it.

**Why narrow:** No mature differ supports PostgreSQL 18 on Windows, macOS and Linux. `pg-delta` is the closest fit but is alpha.

**Revisit when:** `pg-delta` churns, misses object types we need, or leaves alpha; or a prototype shows our own `pg_catalog`/`pg_depend` differ is cheaper to own.

**Research:** `.scratch/super-deploy/research/parsers-and-differs.md`.

## Roles, grants and ownership

**V1:** Roles are cluster-wide and out of scope: the tool never creates or drops them. Grants on managed objects to existing roles are in scope and diffed. Objects are owned by whichever role deploys them and ownership is not diffed. Rehearsals create placeholder roles so grants can be applied.

**Why narrow:** Roles span every database in a cluster, so one project cannot own them safely.

**Revisit when:** Teams need ownership tracked, default privileges (`ALTER DEFAULT PRIVILEGES`) managed, or role existence verified on targets before deploying.

## Extensions

**V1:** The desired schema may only use `plpgsql`, the one extension installed in every database. Every other `CREATE EXTENSION` is refused.

**Why narrow:** Extension install scripts are code the parser cannot see, and some extensions escape the transaction (`dblink`, `postgres_fdw`, `file_fdw`, `adminpack`, `pg_stat_statements`, `pg_prewarm`). Rehearsals must also have the same extensions available as targets.

**Revisit when:** Projects need common extensions. First candidate: a fixed allowlist of extensions that ship with PostgreSQL and stay inside the transaction: `pgcrypto`, `citext`, `pg_trgm`, `btree_gist`, `btree_gin`, `hstore`, `ltree`, `uuid-ossp`, `intarray`, `unaccent`, `fuzzystrmatch`, `tablefunc`, `cube`, `earthdistance`. Then third-party extensions such as PostGIS and pgvector, which need a way to confirm the rehearsal server and target have the same version.

**Research:** `.scratch/super-deploy/research/transactional-hazards.md` §2, open question 4.

## Tolerating drift

**V1:** A deployment refuses on any drift, with no exceptions. An object added to a target by hand, even one identical to what a pending migration would create, blocks the deployment until it is removed or the target is reconciled.

**Why narrow:** Every exception is a way for a target's structure to depend on something other than its recorded migrations.

**Revisit when:** Out-of-band work (see "Operations that cannot run in a transaction") becomes supported. Option: allow an extra object when a pending migration creates one with an identical definition, with generated statements that tolerate it already existing.

## Assertions in scripts

**V1:** No assertion feature. To fail a deployment when data looks wrong, add a constraint (`CHECK`, `NOT NULL`, `UNIQUE`) in the pre-migration script or desired schema; adding it fails the deployment if the data violates it. `DO` blocks are banned, so there is no procedural way to assert.

**Revisit when:** Constraints are too blunt (e.g. a check that should not stay on the table). Option: a tool-level directive such as `-- ASSERT: <message>` followed by a query returning a boolean, run inside the deploy transaction.

## Size-aware lock and rewrite warnings

**V1:** `finalize` warns statically about every statement that rewrites or fully scans an existing table (column type changes, volatile defaults, `SET NOT NULL`, constraint validation, `CREATE INDEX`, `TRUNCATE`). Tables created in the same migration are exempt. Table size is not considered.

**Revisit when:** Warnings become noise on small tables. Option: `status --target` estimates impact from the target's row counts (`pg_class.reltuples`) for each pending warning.

## Partitioned tables

**V1:** Refused in the desired schema.

**Why narrow:** Attaching and detaching partitions takes heavy locks, `DETACH ... CONCURRENTLY` cannot run in a transaction, and recurring partition maintenance (e.g. a partition per month) does not fit a declarative schema.

**Revisit when:** A project needs large time-series tables. Needs a story for partition maintenance outside migrations.

## Object types refused in the desired schema

**V1 refuses:** enums, partitioned tables, extensions other than `plpgsql`, rules (`CREATE RULE`), event triggers, foreign tables and foreign data wrappers, publications and subscriptions, custom casts, operators, aggregates (`CREATE AGGREGATE`), collations and text-search configurations, standalone sequences (identity sequences are allowed), `CREATE STATISTICS`, `serial`/`bigserial` columns, `NOT ENFORCED` constraints, and `VIRTUAL` generated columns.

**Why narrow:** Each adds differ coverage, rehearsal-parity or transaction-safety work that V1 does not need.

**Revisit when:** A real project needs one. Enums, partitioning and extensions have their own entries above.

## SQL formatting

**V1:** No automatic SQL formatting. Biome formats TypeScript and JSON; the Postgres Language Server gives in-editor SQL diagnostics; `validate` is the authoritative SQL check. Finalized files and the generated schema change are never reformatted.

**Revisit when:** A SQL formatter proves reliable on PostgreSQL 18 syntax. It would apply only to the desired schema and to scripts while they are still in a draft.

## Publishing

**V1:** Not published. The library is used from the workspace (the example and template packages). Planned shape once published: public npm package (name to be confirmed free on npm), MIT licence, versioned with Changesets, `0.x` until migration file formats and the history schema layout are stable.

**Revisit when:** V1 is complete.

## Placeholder roles in rehearsals

**V1:** A rehearsal creates any missing role that the desired schema grants to, as `NOLOGIN`, and never drops it. The rehearsal adapter's login therefore needs `CREATEROLE`. On real targets the tool never creates roles; `status` and `deploy` check that every granted role exists, and `deploy` refuses if any is missing.

**Why narrow:** Roles are cluster-wide. Leaving harmless `NOLOGIN` roles behind is simpler and safer than dropping roles another project's concurrent rehearsal may be using.

**Revisit when:** Leftover roles accumulate on shared rehearsal servers, or `CREATEROLE` is unavailable there. Options: per-project role-name prefixes with cleanup, a declared list of expected roles in config, or rehearsing without grants and checking them separately.

## Virtual generated columns

**V1:** Refused, including PG18's default (a generated column with neither `STORED` nor `VIRTUAL` is virtual).

**Why narrow:** `@supabase/pg-delta@1.0.0-alpha.59` silently emits virtual generated columns as `STORED`, and its own re-diff does not notice. A virtual column is cheap to add (no table rewrite), so this is a real loss.

**Revisit when:** pg-delta fixes it upstream (re-run the prototype), or our own `pg_catalog` comparison can catch and correct it.

**Research:** `.scratch/super-deploy/research/pg-delta-prototype.md`.

## Order-independence: proof instead of sampling

**V1:** The desired schema is loaded in one extra valid order and the catalogs compared. Known causes of order dependence are refused statically (unnamed indexes and constraints, duplicate unique keys under a foreign key, function calls in column syntax).

**Why narrow:** Sampling catches every order-dependent case found in research with no false positives, but it does not prove independence.

**Revisit when:** A new order-dependent case is found. Each one found should become a static refusal or an extra modelled reference.

**Research:** `.scratch/super-deploy/research/schema-ordering.md`.
