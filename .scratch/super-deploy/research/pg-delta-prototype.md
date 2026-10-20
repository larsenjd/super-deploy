# Research: pg-delta differ prototype (issue 01)

Compiled 2026-10-19 from a throwaway prototype run against real PostgreSQL 18. The code is on branch `prototype/pg-delta`, folder `prototype-pg-delta/`. Run it with `pnpm prototype:pg-delta` from the repo root. Raw output from the run these findings come from is in `prototype-pg-delta/output/`: `console.txt`, `results.json`, and the generated schema change for each scenario in `schema-changes/*.sql`.

## Versions tested

| Item | Exact version |
|---|---|
| `@supabase/pg-delta` | **1.0.0-alpha.59** (2026-10-12; dist-tag `alpha`. `latest` is a 0.0.0 placeholder). `ENGINE_VERSION` = `0.3.0` |
| `@supabase/pg-topo` (optional peer) | 1.0.0-alpha.8. It pulls in `@libpg-query/parser@17.6.10` (PG**17** grammar), `@pgsql/traverse@17.2.6` and `plpgsql-parser@0.5.16` |
| `embedded-postgres` | 18.4.0-beta.17 (`@embedded-postgres/linux-x64@18.4.0-beta.17`) |
| PostgreSQL server | 18.4 (x86_64-pc-linux-gnu, from embedded-postgres) |
| `pg` | 8.23.1 |
| Node / pnpm | v24.21.0 / 12.9.1 |
| OS | Linux x64 (CachyOS). **Windows was not tested**: no Windows machine was available |

## Verdict

**Wrap pg-delta**, pinned to exactly `1.0.0-alpha.59`, behind our `Differ` interface, on four conditions (§7). The engine passed the criteria that are hard to build ourselves: dependency ordering, column order and byte-identical output. Every failure the prototype found was narrow, and each is either detectable or already tracked upstream. One is a silent PG18 bug (virtual generated columns become `STORED`). It means our verification step must not rely on pg-delta's own re-diff alone.

## 1. Column order (criterion 1): PASS

| Case | Result |
|---|---|
| Target has `t(id, a, c, b)` because `b` was added later. Desired is `t(id, a, b, c)` | **0 statements**. The independent `pg_catalog` check also shows no difference |
| Desired adds `b` mid-table to `t(id, a, c)`, which has 1 row | Exactly `ALTER TABLE "public"."t" ADD COLUMN "b" text;`. The column lands at the end (`id,a,c,b`), the row is kept, and the re-diff is empty |
| `CREATE VIEW v AS SELECT * FROM t` over tables whose physical order differs (informational) | pg-delta sees that the **view's** column order differs and emits `DROP VIEW` + `CREATE VIEW` with an explicit column list. Afterwards the view columns match and the re-diff is empty. This is correct: a view's column order is visible to callers. |

pg-delta stores a column's position as `_position`, and canonicalisation, hashing and diffing ignore it by design. Upstream notes the same blind spot for **composite-type attribute order**, which pg-delta does not diff (pg-toolbelt #330/#332). Unlike table column order, that order is semantic.

## 2. Object coverage (criterion 2): 82 of 90 round trips pass

Method: each object type in spec §4.1 has three database states, a, b and c. That gives three round trips per type: create (a→b), alter (b→c) and drop (c→a). Each round trip: build the source and the desired database fresh, diff source→desired, and apply the generated SQL to the source **in one transaction** with our §7.4 settings (`search_path = public, pg_catalog`, `check_function_bodies = on`). Then require (1) an empty pg-delta re-diff, (2) an empty **engine-independent `pg_catalog` comparison** (`prototype-pg-delta/src/catalog.ts`, which ignores column order and normalises ACLs with `acldefault`), and (3) no non-transactional actions.

All of these passed create, alter and drop: tables, stored generated columns, primary keys, foreign keys, unique (including `NULLS NOT DISTINCT`), checks, exclusion constraints, indexes (partial and expression), views (including changes that need a drop and recreate), materialized views (+ index, `WITH NO DATA`), identity columns (`ALWAYS` changed to `BY DEFAULT`, start/increment), functions (`plpgsql`, `LANGUAGE sql`, `BEGIN ATOMIC`, signature change), procedures, triggers (events, `WHEN`), domains (constraints, default, `NOT NULL`), composite types (add attribute while a table column uses the type), RLS enable/force with policies (permissive and restrictive, roles, `WITH CHECK`), comments, and grants (table, column, function, `REVOKE … FROM PUBLIC`). Dependency cases also passed:
- a column type change under a view, a policy and an index (it drops the policy and view, alters the type, then recreates them);
- circular foreign keys (both FKs are emitted as `ALTER TABLE … ADD CONSTRAINT`);
- a view-on-view chain over a `LANGUAGE sql` function and a domain.

**Every action pg-delta emitted was `transactional`**, so nothing would break ADR-0001.

Failures:

| # | Case | What happened | Severity |
|---|---|---|---|
| F1 | **Virtual generated column (PG18)**: create, alter, and stored→virtual | pg-delta reads `attgenerated` only as "is generated" and always renders `GENERATED ALWAYS AS (…) STORED` (`dist/plan/rules/helpers.js:339`). Desired `VIRTUAL` becomes `STORED` on the target. Its own re-diff is **empty**, so its `prove` step and our planned re-diff check would both pass. A stored→virtual change produces **0 statements**. Only the independent catalog check caught it. No upstream issue found (searched "virtual", "STORED"). | **High**: silent and wrong, and in our supported list |
| F2 | `CHECK (qty BETWEEN 0 AND 100 AND (qty, id) > (0, 0))`, alter | Never converges. The re-diff after applying emits the same drop/add again, because PostgreSQL's printout of nested `AND` is not a fixed point. This is upstream **#544 (open)**. pg-delta's mitigation (`settleDesired`) runs only inside `planSchemaFiles` and is **not exported** (not in the `exports` map). | Medium: rehearsal (§5.3) would fail loudly. Not silent |
| F3 | Named `NOT NULL` constraint renamed (`t_name_not_null` → `name_required`) | It emits `SET NOT NULL` correctly but ignores PG18 not-null constraint **names**. The re-diff is empty; the catalog check shows the name differs. | Low |
| F4 | `COMMENT ON INDEX t_pkey` (an index that backs a constraint) | Not extracted, so it is never created or dropped. | Low |
| F5 | Domain base type changed while a column uses it (`numeric(12,2)` → `numeric(14,2)`) | `plan()` **throws**: "cannot replace an in-use domain … not supported yet". | Low: it refuses loudly. PostgreSQL has no `ALTER DOMAIN … TYPE` either; a pre-migration script would handle it. |

Minor noise: some type changes carry a redundant `ALTER COLUMN … DROP DEFAULT`. Extraction reports a harmless `dangling_edge` diagnostic for every generated column.

## 3. Determinism (criterion 3): PASS, 91 of 91 byte-identical

All 90 scenarios ran 3 times. Each run used freshly created databases and inserted throwaway create/drop "noise" to shift OIDs. The SHA-256 of the rendered SQL matched in every case. A combined schema (all 30 cases, each in its own schema, 110 statements from empty) loaded forward, reversed, and forward with noise also gave the same hash all three times (`ee0ae536f1d3c407…`). This matches pg-delta's claim of "one deterministic sort".

## 4. Directory loader and file order (criterion 4, Q35): evidence only, not decided

### What the loader actually does

`pgdelta schema apply --dir` is `planSchemaFiles` → `loadSqlFiles`, and it **does not sort files by dependency**. It reads files **lexicographically** (`readdirSync().sort()` per directory, recursively). It then applies them in **bounded retry rounds**: a file that fails is retried in a later round. With the default `statementFallback` it keeps the statements that succeeded and retries only the rest. If a round makes no progress it escalates: reconnect, then move "late-kind" files last, then split the stuck file into kind-ordered statements. That escalation uses `@supabase/pg-topo` as an *advisory* hint when installed. This is the "retry-until-no-progress" loading that `pending-decisions.md` currently puts in REFINEMENTS. pg-topo is the only static dependency sorter, and it parses with the **PG17** grammar.

### Fixtures (`prototype-pg-delta/fixtures/`)

- `q35-shuffled/`: 9 files named so that path order is roughly the reverse of dependency order. They contain a policy that calls a `LANGUAGE sql` function (binds at `CREATE`), views on views, a trigger, a `BEGIN ATOMIC` function, a domain and a composite type, a PG18 `VIRTUAL` column, and an FK cycle closed by `ALTER TABLE … ADD CONSTRAINT` in a sub-folder.
- A PG17-parseable variant of the same files (`VIRTUAL` → `STORED`).
- `q35-numbered`: the same files renamed `01-types.sql` … `09-policies.sql` (including `05-constraints/…`).
- `q35-overload-binding/`: `pick(numeric)`, a view calling `pick(1)`, and `pick(integer)`.
- A typo file, and an inline FK cycle with no `ALTER` (unsatisfiable).

"Same as reference" means the loaded database matched, in the independent `pg_catalog` comparison, a database loaded by hand in true dependency order.

| Fixture | `schema apply --dir` (defaults) | retry only, no pg-topo | whole-file retry only | pg-topo static order, one pass | path order, one pass |
|---|---|---|---|---|---|
| shuffled, PG18 syntax | ✅ same as reference (warns that pg-topo could not parse 1 input) | ✅ same | ✅ same (5 rounds) | ❌ the `VIRTUAL` file fails to parse and drops out of the order → `relation "orders" does not exist` | ❌ `a_policies.sql: relation "orders" does not exist` |
| shuffled, PG17 syntax | ✅ same | ✅ same | ✅ same (5 rounds) | ✅ same | ❌ same error |
| numbered prefixes | ✅ same | ✅ same | ✅ same (1 round) | ❌ PARSE_ERROR again | ✅ same |
| overload binding | ⚠️ loads, view binds **`pick(numeric)`** | ⚠️ `pick(numeric)` | ⚠️ `pick(numeric)` | binds **`pick(integer)`** (functions first) | ⚠️ `pick(numeric)` |
| typo | ❌ after 8 rounds: `j_typo.sql: syntax error at or near "tabel" — at line 1` ("failed identically in 8 round(s)") | ❌ 6 rounds, same message | ❌ 7 rounds | ❌ | ❌ immediately, Postgres's own error |
| inline FK cycle | ❌ "stuck" with a tip to split one FK into `ALTER TABLE … ADD CONSTRAINT` | ❌ same tip | ❌ same tip | ❌ `CYCLE_DETECTED` | ❌ `relation "b" does not exist` |

pg-topo on individual PG18 statements: **parse errors** on `GENERATED … VIRTUAL`, `WITHOUT OVERLAPS`, `NOT ENFORCED` and the table-level `CONSTRAINT x NOT NULL col`. It parses `RETURNING old.*/new.*`. `analyzeForShadow` drops an unparseable file from its ordered output; `orderForShadow` throws instead.

The overload case is the important one. Every loader "succeeds", but the desired schema it produces depends on the order statements happened to run in. Lexicographic-plus-retry and path order agree here only because both start from file names.

Path sorting: pg-delta's CLI sorts each directory's entries separately, using UTF-16 `sort()`. The spec's fallback sorts whole `/`-joined paths by code point. These differ when a folder name is a prefix of a sibling file name. Example: pg-delta gives `a/b.sql, a-c.sql, a.sql`; the spec rule gives `a-c.sql, a.sql, a/b.sql`.

### Options for the user to decide (Q35)

- **A. Use pg-delta's loader (no ordering convention).** It handles any file names, including PG18 syntax and FK cycles done with `ALTER`, and gives good stuck-file errors. Costs: the desired schema is loaded by pg-delta's loader, not our own plain SQL application; that is a second coupling point (its defaults suit Supabase: DML and function-body failures are warnings unless `strictDataStatements`/`strictFunctionBodies` are set). Load order is still implicit (lexicographic, then retries), so overload/binding order is decided by file names without the author seeing it. Every rehearsal and drift check must reuse the same loader to rebuild D identically. A genuine error costs N rounds before it surfaces.
- **B. Static dependency sort with pg-topo.** Reliable only when everything parses. On PG18 syntax it is **not reliable**, because its parser is PG17. It adds a second, older libpg-query WASM (~7.3 MB) next to our `libpg-query@18`. If adopted, it should be by porting the idea onto our PG18 parser, not by using pg-topo.
- **C. Path order with numbered prefixes (current spec fallback).** Deterministic, visible to the author, one pass. It fails fast with PostgreSQL's own error naming the file. The numbered fixture loaded identically to the reference. Costs: authors keep prefixes in order. FK cycles need the `ALTER TABLE … ADD CONSTRAINT` in a later file, which §4.1 already allows.
- **D. Hybrid.** Path order defines the semantics. Only when a file fails, run a retry/topo analysis to *suggest* a reorder in the error message, without loading in that order.

## 5. API surface we would wrap (criterion 5)

What the prototype's `Differ` needed (`prototype-pg-delta/src/differ.ts`):

```ts
import { plan, diff, ENGINE_VERSION, type Plan, type Action } from "@supabase/pg-delta";
import { resolveProfile, rawProfile } from "@supabase/pg-delta/integrations";

const profile = await resolveProfile(sourcePool, rawProfile);   // or extract() from "@supabase/pg-delta/extract"
const s = await profile.extract(sourcePool);                    // { factBase, pgVersion, diagnostics }
const d = await profile.extract(desiredPool);
const p = plan(s.factBase, d.factBase, {
  ...profile.planOptions,
  scope: "database",            // never manage roles (spec §10.2)
  defaultOwner: "<deploy role>",// no ALTER … OWNER TO (ownership not diffed)
  assumedRoles: [/* every role name; without it plan() throws "missing requirement: role:…" */],
  // renames: "off" (default): renames are the pre-migration script's job
});
p.actions: Action[]  // { sql, verb, transactionality, dataLoss, rewriteRisk, lockClass, produces/consumes/destroys }
```

- Per-action metadata maps straight onto our rules. `dataLoss: "destructive"` gives §4.5 acknowledgements. `rewriteRisk` and `lockClass` give the §4.6 warnings. `transactionality` lets us refuse non-transactional output (ADR-0001). `classifyPlanHazards` and `dataLossActions` also exist.
- We would **not** use `apply()` (it segments with `BEGIN`/`COMMIT`, `RESET ALL` and its own preamble), `renderApplyScript`, the CLI, `.pgdelta-export.json`, `_custom/`, or the Supabase profile. We would use `provePlan` only optionally. The generated SQL is schema-qualified. Routine bodies are emitted verbatim from `pg_get_functiondef` and ran fine under our §7.4 `search_path = <managed>, pg_catalog` with `check_function_bodies = on`. pg-delta's own preamble is `search_path = pg_catalog`.
- For `meta.json`: package version `1.0.0-alpha.59` plus `ENGINE_VERSION` `0.3.0`.

Footprint: the package is 5.8 MB installed (2.5 MB `dist`, 3.3 MB TypeScript `src` shipped alongside), about 42k lines of non-test source. Runtime dependencies are only `pg`, `debug` and `pg-connection-string`; `engines.node >= 20`; ESM. `@supabase/pg-topo` is an *optional* peer, and we would leave it out (it adds ~10 MB of PG17 parser, Babel and protobuf). **Licence: "PostgreSQL"** in `package.json`. `research/parsers-and-differs.md` says MIT, which is wrong for this version. Speed: one round trip (2 fresh databases, 3 extracts, plan, apply) took about 0.8 s on these small schemas.

Churn: 60 alpha releases since 2025-12. alpha.34 (2026-08-09) was a clean-room rewrite that replaced the whole API and artifact formats. There were 26 releases between 2026-07-24 and 2026-10-12. Pin exactly, and upgrade only by re-running this prototype's suite.

Supabase-specific assumptions to stay clear of:
- integration profiles: the `supabase` profile assumes `auth`, `storage` and other platform schemas and roles, and handlers for `pg_cron`, `vault` and others;
- the default `cluster` scope manages roles (we must pass `scope: "database"`);
- loader defaults tuned for the Supabase CLI: DML in desired files, and function bodies that fail `check_function_bodies`, are only warnings; pre-existing rows are tolerated in isolated mode; assumed schemas are seeded;
- the `_custom/` folder and `-- pgdelta-migration:` directives;
- export manifests.

None of these is needed with `rawProfile` and the low-level `extract`/`plan`.

## 6. Other observations

- Windows untested. pg-delta is pure TypeScript and uses only `pg`, the prototype uses no shell, and embedded-postgres ships `windows-x64`. A CRLF-in-function-body diff bug was fixed upstream (pg-toolbelt #242).
- pnpm 12 blocks dependency build scripts by default. `@embedded-postgres/<platform>` needs its `postinstall` (`hydrate-symlinks.js`) allowed via `allowBuilds` in `pnpm-workspace.yaml`. Without it the binaries' shared-library symlinks are missing. The template will need the same setting.
- PG18 refuses virtual generated columns whose expression uses a user-defined type ("generation expression uses user-defined type").
- `DROP DATABASE … WITH (FORCE)` kills idle `pg.Pool` clients and raises an unhandled `'error'` event unless the pool has an error listener. Rehearsal adapters will need the listener.

## 7. Recommendation: wrap pg-delta, on these conditions

1. **Pin `@supabase/pg-delta@1.0.0-alpha.59` exactly. Do not install `@supabase/pg-topo`.** Call `extract` and `plan` directly, and load the desired schema ourselves (its loader only if Q35 picks option A).
2. **Make differ verification (spec §2) engine-independent for real.** Add a `pg_catalog` comparison like `prototype-pg-delta/src/catalog.ts` next to the pg-delta re-diff, so attributes pg-delta does not model get caught: `attgenerated` (F1), not-null constraint names (F3), index comments (F4), composite attribute order.
3. **Virtual generated columns (F1):** report the bug upstream and either wait for the fix or refuse `VIRTUAL` in V1 until it lands. Our wrapper could also rewrite `STORED`→`VIRTUAL` for columns the desired catalog marks `attgenerated = 'v'`, but that is a fragile patch. In every case, condition 2 catches it.
4. **Non-converging expressions (F2):** track #544. Ask upstream to export `settleDesired`, or document that `BETWEEN`/row comparisons in checks can fail rehearsal until fixed.

Why not build our own: what passed here (dependency-ordered drop/recreate around type changes, FK cycles, view chains, grants with `acldefault` normalisation, identity/domain/policy alters, byte-identical output) is the expensive part. pg-delta has about 42k lines of source and a 331-scenario corpus run on PG14–18. Every failure found is narrow and either caught by condition 2 or loud. Revisit if alpha churn breaks the wrapper repeatedly, if F1 is not fixed upstream, or if a future prototype run finds silent failures that condition 2 does not catch. The fallback stays as the spec describes: our own `pg_catalog`/`pg_depend` differ behind the same interface. `catalog.ts` is a small seed for it.

## Sources

- npm registry metadata for `@supabase/pg-delta`, `@supabase/pg-topo` and `embedded-postgres` (versions, release times, dependencies, licence), read 2026-10-19.
- Installed package contents: `@supabase/pg-delta@1.0.0-alpha.59` `README.md`, `dist/**/*.d.ts`, `dist/frontends/schema-plan.js`, `dist/cli/commands/schema.js`, `dist/plan/rules/helpers.js`, `dist/extract/relations.js`.
- GitHub issues in [supabase/pg-toolbelt](https://github.com/supabase/pg-toolbelt): #330, #332 (model fidelity gaps), #544 (BETWEEN never converges), #242 (CRLF in function bodies).
- The prototype run: `prototype-pg-delta/output/console.txt` and `results.json` on branch `prototype/pg-delta`.
