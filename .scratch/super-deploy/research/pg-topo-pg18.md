# Research: does `@supabase/pg-topo` support PostgreSQL 18?

Compiled 2026-10-19. Sources: the npm registry, GitHub (`supabase/pg-toolbelt`: main, all 76 branches, issues and PRs), the published tarball, and a throwaway prototype run against real PostgreSQL 18.4.

- Code: branch `prototype/pg-topo-pg18` (based on `prototype/schema-ordering`), folder `prototype-pg-topo-pg18/`. Run it with `pnpm prototype:pg-topo-pg18` from the repo root (about a minute).
- Raw output: `prototype-pg-topo-pg18/output/console.txt` and `results.json`. Two runs gave identical output.
- This document gives evidence only. **Q35 is not decided here.** See `pending-decisions.md`.

## Answer

**No published version of pg-topo supports PostgreSQL 18, and nothing upstream is working towards it.**
- Every version from `1.0.0-alpha.0` to `1.0.0-alpha.8` (the newest) parses with the **PG17** grammar.
- No branch, open PR or issue in `supabase/pg-toolbelt` moves pg-topo to the PG18 parser.
- pg-topo's own tests run against `postgres:17-alpine`.

What *does* support PG18 is **pg-delta**, the differ, through PRs such as #174 (PG18 not-null constraints in introspection) and #485. It is easy to read that as "the toolbelt supports PG18", but pg-topo is a separate package with its own parser.

The earlier finding in `pg-delta-prototype.md` is **confirmed** on alpha.8:
- PG18 syntax produces parse errors;
- a file that fails to parse is dropped **whole**;
- the only signal is a `PARSE_ERROR` diagnostic.

**PG18 parsing is not the only problem.** Ten extraction gaps hit forms V1 supports, independent of PostgreSQL version and of how the parser dependencies are set (§4.2). Its ordering also still depends on file names and the process locale (§5).

## 1. Versions

Read from the npm registry and GitHub on 2026-10-19.

| Version | Published | Licence | Declared parser deps | Resolves to (grammar) |
|---|---|---|---|---|
| `0.0.0` (dist-tag `latest`) | 2026-02-18 | ISC | none | placeholder, no code |
| `1.0.0-alpha.0` | 2026-02-18 | MIT | `plpgsql-parser ^0.5.4`, `@pgsql/traverse ^17.2.4` | PG17 |
| `1.0.0-alpha.1` | 2026-03-09 | MIT | same | PG17 |
| `1.0.0-alpha.2` | 2026-06-12 | MIT | same | PG17 |
| `1.0.0-alpha.3` | 2026-06-23 | MIT | same | PG17 |
| `1.0.0-alpha.4` | 2026-07-24 | MIT | same | PG17 |
| `1.0.0-alpha.5` | 2026-08-03 | MIT | same | PG17 |
| `1.0.0-alpha.6` | 2026-08-25 | MIT | same | PG17 |
| `1.0.0-alpha.7` | 2026-09-30 | MIT | same | PG17 |
| **`1.0.0-alpha.8`** (dist-tag `alpha`, newest) | 2026-10-06 | PostgreSQL | same | **PG17**: `plpgsql-parser@0.5.16` → `@libpg-query/parser@17.6.10`, `@pgsql/traverse@17.2.6` |
| `main` (toolbelt, 2026-10-19) | unreleased | PostgreSQL | same; `bun.lock` pins `@libpg-query/parser@17.6.10`, `@pgsql/traverse@17.2.6` | PG17 |

**Why the dependency ranges lock it to PG17.** `^0.5.4` admits only `plpgsql-parser` 0.5.x. Every 0.5.x depends on `@libpg-query/parser ^17.6.3`.

**The PG18 parser chain already exists on npm:**
- `plpgsql-parser` 1.0.0 (2026-07-21) and 18.x (now `18.5.14`, 2026-10-13) moved to `libpg-query@18` and `@pgsql/traverse@18`;
- `@libpg-query/parser@18.0.0` has the dist-tag `pg18`;
- `libpg-query@18.1.5` is `latest`.

pg-topo has not adopted any of them.

Other evidence that nothing is in progress:
- **Branches:** all 76 branches of `supabase/pg-toolbelt` were checked (`packages/pg-topo/package.json` on each). Every branch that has pg-topo declares the same PG17 dependencies. `copilot/add-postgresql-temporal-constraints-support` and closed PR #186 touch pg-delta only.
- **Issues and PRs:** searches for `pg-topo`, `pg18`, `libpg-query`, `postgres 18` and `virtual` turn up no pg-topo parser upgrade.
- **Recent pg-topo commits:** range types (#500, 2026-09-30), relicensing (#508), privilege facts (#450) and byte-offset slicing (#372).
- **Tests:** `packages/pg-topo/test/support/postgres/postgres-container.ts` uses `POSTGRES_VALIDATION_IMAGE = "postgres:17-alpine"`.
- **Upstream intent:** `docs/architecture/target-architecture.md` §4.4 calls pg-topo an "advisory", developer-experience layer outside the trusted path. Its evolution is "deliberately outside the staged build". The README says the same: "advisory static analysis, never a trusted source of truth".

## 2. What was tested

Two variants of the **same** alpha.8 tarball:

| Variant | Parser chain |
|---|---|
| **stock alpha.8** | As published (PG17) |
| **alpha.8 + PG18 overrides** | pnpm `overrides` force `plpgsql-parser@18.5.14` (→ `libpg-query@18.1.5`) and `@pgsql/traverse@18.7.14`. Upstream does not ship this. It tests whether a port is "just a dependency bump" |

Both are compared with the schema-ordering PoC (`prototype-schema-ordering/src/analyze.ts`, on `libpg-query@18.1.5`).

Environment: PostgreSQL 18.4 (`embedded-postgres` 18.4.0-beta.17), Node v24.21.0, pnpm 12.9.1, Linux x64.

Each **matrix case** (`src/cases.ts`) is a few statements written in a valid order.
- They are fed to pg-topo **reversed**, one input per statement, so pg-topo must reorder them.
- The result is loaded into a fresh database in one transaction (`check_function_bodies = on`), and its catalog is compared with the authored order.
- **"Edges-only"** loads 4 other valid orders of pg-topo's *own* dependency graph: latest-ready-first, and 3 seeded random orders. These ignore pg-topo's phase, class and path tie-breaks. If one fails, pg-topo is missing an edge and only its tie-break hid it, much like the determinism guard in `schema-ordering.md` §4.
- The PoC gets the same treatment: its own order, plus 4 alternative orders.

## 3. Test matrix

Key:
- **OK** = loads, with the same catalog as the authored order.
- **PARSE_ERROR** = the input is dropped from the order.
- **LOAD FAILED** = pg-topo's own order does not load.
- **edges-only n/4** = n alternative valid orders of its graph fail.

| Case | V1 | PG18 syntax | stock alpha.8 | alpha.8 + PG18 overrides | PoC (libpg-query 18) |
|---|---|---|---|---|---|
| C01 tables, PK, UNIQUE, inline FK | supported | | OK | OK | OK |
| C02 FK cycle closed with `ALTER TABLE … ADD CONSTRAINT` | supported | | OK | OK | OK |
| C03 CHECK calling a user function, UNIQUE, EXCLUDE (gist) | supported | | OK | OK | OK |
| C04a NOT NULL, column-level, named | supported | | OK | OK | OK |
| C04b `CONSTRAINT x NOT NULL col` (table-level) | supported | ✔ | **PARSE_ERROR** | OK | OK |
| C04c `ALTER TABLE … ADD CONSTRAINT x NOT NULL col` + `COMMENT ON CONSTRAINT` | supported† | ✔ | **PARSE_ERROR** | OK; edges-only **4/4 fail** (E8) | OK |
| C05 STORED generated column calling a user function | supported | | OK | OK | OK |
| C06a `GENERATED … VIRTUAL` | refused (pending) | ✔ | **PARSE_ERROR** | OK | OK |
| C06b `GENERATED ALWAYS AS (…)`, no keyword (PG18 default: virtual) | refused (pending) | ✔ | **PARSE_ERROR** | OK | OK |
| C07 identity columns | supported | | OK | OK | OK |
| C08 unique expression index with user function, partial, INCLUDE | supported | | OK | OK | OK |
| C09 view chain, `security_invoker`, materialized view + index | supported | | OK | OK | OK |
| C10a `LANGUAGE sql` string body reading a table (unqualified) | supported | | OK; edges-only **3/4 fail** (E2) | same | OK |
| C10b `LANGUAGE sql` string body reading a **view** (unqualified) | supported | | **LOAD FAILED** (E2) | same | OK |
| C10c same, schema-qualified `public.` | supported | | OK | OK | OK |
| C11 `BEGIN ATOMIC` body reading a view; `RETURN` body calling a function | supported | | **LOAD FAILED** (E1) | same | OK |
| C12 `SETOF` rowtype, `RETURNS TABLE`, default argument calling a function | supported | | **LOAD FAILED** (E1, E3) | same | OK |
| C13 procedures: `BEGIN ATOMIC`, PL/pgSQL | supported | | OK; edges-only 1/4 fail (E1) | same | OK |
| C14 PL/pgSQL trigger function; trigger `WHEN` calling a function | supported | | OK; edges-only 2/4 fail (E4) | same | OK |
| C15 domain over domain, composite type with a domain attribute, arrays | supported | | **LOAD FAILED** (E5) | same | OK |
| C16 RLS enable/force, policies (function, subquery, `TO role`) | supported | | OK; edges-only **4/4 fail** (E2) | same | OK |
| C17 `COMMENT ON` 13 kinds | supported | | OK; edges-only **4/4 fail** (E8) | same | OK |
| C18 `GRANT` on table, columns, view, function, procedure, type, domain, identity sequence | supported | | OK; edges-only 3/4 fail (E9) | same | OK |
| C19 `CREATE EXTENSION plpgsql` | supported | | OK | OK | OK |
| C20a `PRIMARY KEY (…, during WITHOUT OVERLAPS)` | unclear | ✔ | **PARSE_ERROR** | OK | OK |
| C20b temporal FK `… PERIOD during` | unclear | ✔ | **PARSE_ERROR** (both inputs) | OK | OK |
| C20c `UNIQUE (…, during WITHOUT OVERLAPS)` | unclear | ✔ | **PARSE_ERROR** | OK | OK |
| C21 `NOT ENFORCED` CHECK and FK | refused | ✔ | **PARSE_ERROR** | OK | OK |
| C22a `RETURNING old.n, new.n` in `BEGIN ATOMIC` | supported | ✔ | parses; OK; edges-only 3/4 fail (E1) | same | OK |
| C22b `RETURNING WITH (OLD AS o, NEW AS nw)` in a string body | supported | ✔ | parses (the body is a string); edges-only 3/4 fail (E2) | same | OK |
| C23 `uuidv7()` default, `casefold()` check | supported | ✔ | OK (2 spurious `UNRESOLVED_DEPENDENCY`) | same | OK |
| C24 `NOT NULL NO INHERIT`, `CHECK … NO INHERIT` | unclear | ✔ | **PARSE_ERROR** | OK | OK |
| C25 `'rc'::regclass` default; `rc.n%TYPE` argument | supported | | **LOAD FAILED** (E6, E7) | same | OK |
| C26 functional notation `c.order_count` | supported | | OK; edges-only 3/4 fail (E10) | same | OK; edges-only **4/4 fail** (the same gap) |
| C27 CTE named like a real table | supported | | OK | OK | OK |

† §4.1 allows `ALTER TABLE … ADD CONSTRAINT` "for circular foreign keys". Whether a NOT NULL constraint added that way is allowed is not stated.

### Fixtures (`analyzeAndSortFromFiles`), compared with the PoC

| Fixture | stock alpha.8 | alpha.8 + PG18 overrides |
|---|---|---|
| q35-shuffled (has `VIRTUAL`) | **13/17 statements**: `f_orders.sql` dropped whole (PARSE_ERROR); 8 warnings; **LOAD FAILED** `relation "orders" does not exist` | 17/17; same catalog as the PoC; edges-only 4/4 fail (E1/E2) |
| q35-overload-binding | same catalog as the PoC (`pick(integer)`) | same |
| overloads | **different catalog** from the PoC: `uses_fmt()` (`BEGIN ATOMIC`) binds `fmt(numeric)`, not `fmt(integer)`. **Renaming the files changes the binding** | same |
| overload-ambiguous | LOAD FAILED: `function fmt(integer) does not exist`. The table ran first: no edge to either candidate (PoC: PostgreSQL's "is not unique") | same |
| extraction-gap, domain-composite, sql-functions, triggers-policies, fk-index-choice | same catalog as the PoC; edges-only 3–4/4 fail (E1/E2/E5/E9) | same |
| view-chain | same catalog; edges-only OK | same |
| unnamed-index | **different catalog** (`t_a_idx` / `t_a_idx1` swapped); **renaming the files swaps them again** | same |
| cycle-error | `CYCLE_DETECTED`, then a cycles-last total order that fails to load | same |
| unresolved (typos) | 2 `UNRESOLVED_DEPENDENCY` warnings; the order is returned anyway and fails at load | same |

Renaming every file so that path order reverses changed pg-topo's statement order in 11 of 13 fixtures. The catalog changed in 2 of them (overloads, unnamed-index). The PoC's order is invariant under renames (`schema-ordering.md` §3).

## 4. What pg-topo excludes or mishandles, classified against V1

Classes:
- **(a)** conflicts with something V1 supports;
- **(b)** only affects things V1 refuses anyway;
- **(c)** unclear.

### 4.1 Grammar (stock alpha.8 only; the PG18 override fixes all of these)

| # | Item | Class |
|---|---|---|
| G1 | Table-level `CONSTRAINT x NOT NULL col` | **(a)**: NOT NULL is a supported constraint, and PG18 users write this form |
| G2 | `ALTER TABLE … ADD CONSTRAINT x NOT NULL col` | (c): the ADD CONSTRAINT form is allowed, but whether it covers NOT NULL is not stated |
| G3 | `GENERATED … VIRTUAL`, and `GENERATED ALWAYS AS (…)` with no keyword (virtual by default in PG18) | (b) once the pending VIRTUAL refusal lands. Until then it is (a) against the §4.1 text ("stored and virtual generated columns"). Note: a refusal must also catch the **keyword-less** form |
| G4 | `WITHOUT OVERLAPS`, `PERIOD` (temporal PK, UNIQUE and FK) | (c): modifiers on supported constraint kinds; §4.1 is silent |
| G5 | `NOT ENFORCED` | (b) |
| G6 | `NOT NULL NO INHERIT` | (c): inheritance and partitioning are effectively out of V1 |
| G7 | **What happens on any parse error**: the whole input (file) is dropped from `ordered`, with only a `PARSE_ERROR` diagnostic. Statements that depend on it get `UNRESOLVED_DEPENDENCY` warnings and are ordered anyway. pg-delta's `analyzeForShadow` returned 13 of 17 statements for q35-shuffled; `orderForShadow` throws | **(a)**: one G1 line silently removes every other statement in its file from the order |

Parsed fine by stock: `RETURNING old/new` (syntactically plain column references), `uuidv7()`, `casefold()`.

### 4.2 Extraction gaps (both variants: the same alpha.8 code)

Requirements are probed directly in `console.txt` §3 ("requires extracted per statement"), with schema-qualified references so pg-topo's `qualifiedOnly` rule does not apply.

| # | Missing dependency | Effect seen | Class |
|---|---|---|---|
| E1 | `BEGIN ATOMIC` and `RETURN` bodies (`sql_body`) are not walked: no requirements at all | C11, C12 load failures; C13, C22a; overloads fixture binds a different overload, which then depends on file names | **(a)** |
| E2 | `LANGUAGE sql` string bodies: only **schema-qualified** references are extracted (`qualifiedOnly: true`). V1 desired schemas normally write unqualified names in the managed schema, and with `check_function_bodies = on` these bind at CREATE | C10b load failure; C10a, C16, C22b, sql-functions, q35 | **(a)** |
| E3 | Function argument `DEFAULT` expressions | C12 load failure | **(a)** |
| E4 | Trigger `WHEN (…)` expressions (only table and trigger function are required) | C14 | **(a)** |
| E5 | Composite type (`CREATE TYPE … AS (…)`) attribute types | C15 load failure; domain-composite | **(a)** |
| E6 | `tbl.col%TYPE` is read as a *type* named `tbl.col`: an unresolved warning, no edge to the table | C25 load failure | **(a)** |
| E7 | `'x'::regclass` (and other `reg*`) literals | C25 | **(a)** |
| E8 | `COMMENT ON CONSTRAINT c ON t` requires nothing, not even the table | C04c, C17: the comment can run before its table | **(a)** |
| E9 | Implicitly named objects are unknown: identity sequence `t_id_seq` (`GRANT … ON SEQUENCE`) and PK index `t_pkey` (`COMMENT ON INDEX`). Only a warning, no edge | C18, triggers-policies | **(a)** |
| E10 | Functional notation `row.fn` | C26. **The PoC has the same gap** | **(a)**, shared |
| E11 | Overloads: `fmt(3)` with `fmt(numeric)` and `fmt(bigint)` gives `UNRESOLVED_DEPENDENCY` and **no edge to any candidate**. The PoC adds edges to every overload, so PostgreSQL itself refuses the ambiguous call | overload-ambiguous fails with a misleading "does not exist" | **(a)** (loud, but misleading) |
| E12 | *Override variant only:* PL/pgSQL body references are silently no longer extracted. plpgsql-parser 18 changed its `walk` export, and pg-topo swallows the traversal error | Harmless for ordering: PL/pgSQL is late-bound. It does show the port is **not** a pure dependency bump | (b) for ordering |
| E13 | *Override variant only:* leading comments are no longer in the statement slice (libpg_query 18). `-- pg-topo:` annotations are **silently ignored** (no `INVALID_ANNOTATION`), and our `-- OVERRIDE DANGEROUS COMMAND:` line is not carried in the ordered `sql` | §5 | (c): it matters only if we read the marker from pg-topo's output |

Some of these gaps are hidden by pg-topo's tie-break: phase, then class weight, then path. Those cases load in pg-topo's own order but fail in other valid orders of its graph, e.g. a table before a function before a view. Those cases (C10a, C13, C14, C16, C17, C18, C22, the fixtures) are correct only by luck of the tie-break and file names.

## 5. Determinism concerns from `schema-ordering.md`, rechecked on alpha.8

| Concern | Status on alpha.8 | Evidence |
|---|---|---|
| File-path tie-break uses `localeCompare` | **Still present**, unchanged in `graph/topo-sort.ts`. File discovery (`ingest/discover.ts`) and diagnostic sorting also use `localeCompare`. Neither matches the spec §3.2 code-point rule | Five files with unnamed indexes. Under `LANG=en_US.UTF-8` the order is `t, a, ä, B, z`; under `sv_SE.UTF-8` it is `t, a, B, z, ä`; code-point order is `B, a, t, z, ä`. **The index names `t_a_idx` / `t_a_idx1` swap between the two locales.** Same result in both variants |
| Unresolved references: warn and drop | **Still present.** `UNRESOLVED_DEPENDENCY` is a warning; no edge; the statement is ordered anyway. It cannot simply be promoted to an error: unqualified **built-in** calls (`count`, `sum`, `now`, `length`, `uuidv7`, `casefold`) raise the same warning, because pg-topo has no `pg_catalog` function list. Over sections 1–2 the PG18 override gave 14 warnings: 8 built-ins, 4 extraction gaps (E6, E9, E11) and only 2 real typos | `console.txt` §3 |
| Leading-comment handling | **Stock (PG17):** the slice includes leading comments; annotations work. A file's header comment is attached to its first statement. **PG18 override:** comments are dropped from every slice, and annotations silently stop working (the `phase bootstrap` annotation had no effect) | `console.txt` §3 "leading comments" |
| Parse failures | A whole input is dropped (G7). `analyzeAndSort` returns normally | q35-shuffled |
| Cycles | `CYCLE_DETECTED`, plus a "cycles last" total order. The caller must check the diagnostic before executing | cycle-error |

## 6. What pg-topo does not support yet (short list)

- The PG18 grammar in any release. Affected forms: table-level and `ADD CONSTRAINT … NOT NULL`, `VIRTUAL` (including the keyword-less default), `WITHOUT OVERLAPS` / `PERIOD`, `NOT ENFORCED`, `NOT NULL NO INHERIT`.
- Dependencies inside `BEGIN ATOMIC` / `RETURN` bodies, unqualified references in `LANGUAGE sql` bodies, argument defaults, trigger `WHEN`, composite type attributes, `%TYPE`, `reg*` literals, `COMMENT ON CONSTRAINT`, implicit names (`_pkey`, `_seq`), functional notation.
- Overload-aware edges for calls that match no exact signature.
- An order that is independent of file names and of the process locale.
- A built-in (`pg_catalog`) name list, so unresolved references stay warnings.
- Annotations under the PG18 parser.

## 7. Options (not decided)

- **A. Use pg-topo directly (alpha.8).** Not viable on PG18:
  - G1 alone makes it drop whole files that contain a V1-supported form;
  - E1–E9 cause load failures in its own order on 5 of the 28 V1-supported matrix cases;
  - it is file-name and locale dependent.
- **B. Use pg-topo with the PG18 parser forced through overrides.** It parses PG18, but:
  - it silently loses PL/pgSQL extraction (E12) and annotations (E13);
  - it keeps every extraction gap and the determinism problems;
  - it means relying on an unsupported dependency combination of an alpha package that upstream calls "advisory".
- **C. Fork or port pg-topo.** Steps:
  1. Bump to `plpgsql-parser@18` and adapt to its walker API and the comment-slice change.
  2. Fix E1–E11.
  3. Replace the path tie-break with a content tie-break.
  4. Add a `pg_catalog` name list so unresolved references can be errors.

  The licence (PostgreSQL) permits it. The result would be a 4.9k-line general codebase (roles, extensions, publications, rules, multiple schemas) that we own and must re-sync or diverge from. It is roughly as much work as option D.
- **D. Our own utility (the schema-ordering PoC route, options A / A′ in `schema-ordering.md`).**
  - In this matrix the PoC passed every case, including the PG18 forms, in its own order and all four alternative orders.
  - Its only failure was functional notation (E10), which pg-topo shares.
  - It runs on the `libpg-query@18` parser the §4.1/§4.2 allowlist already needs, and its order is file-name-invariant.
  - Cost: about 2k lines plus a fixture corpus, as estimated in `schema-ordering.md` §6.
- **E. pg-topo as an advisory hint only.** For example, under path-order loading, suggest a reorder when a file fails (option D in `pg-delta-prototype.md`). The PG17 grammar and the gaps still limit the hint's quality, and it adds about 10 MB of a second parser.

Whatever is chosen, the matrix gives reusable cases for any extractor (`prototype-pg-topo-pg18/src/cases.ts`). The keyword-less `GENERATED ALWAYS AS (…)` (virtual in PG18) needs to be in the allowlist tests if V1 refuses `VIRTUAL`.

## Sources

- npm registry metadata, read 2026-10-19: `@supabase/pg-topo` (all versions, times, dependencies, licences, gitHeads), `plpgsql-parser`, `@libpg-query/parser`, `libpg-query`, `@pgsql/traverse`, `@pgsql/types` (versions and dist-tags).
- `@supabase/pg-topo@1.0.0-alpha.8` tarball:
  - `src/ingest/parse.ts`, `src/ingest/discover.ts`;
  - `src/graph/topo-sort.ts`, `src/graph/build-graph.ts`;
  - `src/extract/expression-dependencies.ts` (`qualifiedOnly`, `addRoutineBodyDependencies`);
  - `src/annotations/parse-annotations.ts`;
  - `README.md`.
- `plpgsql-parser@0.5.16` and `@18.5.14` `index.d.ts` (export changes: `walk`, and the parser module `@libpg-query/parser` → `libpg-query`).
- `supabase/pg-toolbelt` on GitHub, read 2026-10-19:
  - `main` `packages/pg-topo/package.json`, `CHANGELOG.md` and `test/support/postgres/postgres-container.ts`;
  - root `bun.lock`;
  - `docs/architecture/target-architecture.md` §4.4, §4.4.1;
  - all 76 branches' `packages/pg-topo/package.json`;
  - issue and PR searches: #186, #174, #485, #500, #508.
- The prototype run: `prototype-pg-topo-pg18/output/console.txt` and `results.json` on branch `prototype/pg-topo-pg18`.
