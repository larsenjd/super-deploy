# Research: ordering desired-schema statements automatically (Q35)

Compiled 2026-10-19. Two sources: a survey of how other tools order DDL (web and npm sources only), and a throwaway proof of concept run against real PostgreSQL 18.

- The code is on branch `prototype/schema-ordering`, folder `prototype-schema-ordering/`. Run it with `pnpm prototype:schema-ordering` from the repo root.
- Raw output from the run these findings come from is in `prototype-schema-ordering/output/console.txt` and `results.json`.
- This document gives evidence only. **Q35 is not decided here.** See `pending-decisions.md`.

## The question

Can super-deploy load a folder of desired-schema `.sql` files into a throwaway PG18 database in dependency order **automatically**, so that:
- users need no file-naming convention, and
- the resulting catalog never depends on file names or load order?

The pg-delta prototype (`research/pg-delta-prototype.md` §4) showed the trap. In the overload-binding fixture every loader "succeeds", but the view binds to `pick(numeric)` or to `pick(integer)` depending on which file name sorts first.

## Versions tested

| Item | Exact version |
|---|---|
| `libpg-query` | **18.1.5** (MIT; the parser reports `version: 180004`). WASM is 1.7 MB |
| `@pgsql/types` | 18.0.0 (dist-tag `pg18`; npm `latest` is still 17.6.2) |
| `@supabase/pg-delta` | 1.0.0-alpha.59. Only `loadSqlFiles`, for comparison. `@supabase/pg-topo` is **not** installed, so pg-delta's optional reorder assist is absent |
| `embedded-postgres` / server | 18.4.0-beta.17 / PostgreSQL 18.4 |
| `pg`, Node, pnpm | 8.23.1, v24.21.0, 12.9.1 (Linux x64; Windows not tested) |

## 1. Survey: how other tools order DDL

| Tool | How it orders | Where the dependency facts come from | Result depends on file names? | Licence |
|---|---|---|---|---|
| **pg_dump** (PG18) | Presort by object-type priority, then name. Then a topological sort that keeps the presort wherever it can. Then repair of dependency loops | `pg_depend`, on objects that **already exist** | No files are involved. The order is a pure function of the catalog | PostgreSQL |
| **@supabase/pg-topo** 1.0.0-alpha.8 | Parse the text. Build a provides/requires graph. Run Kahn's algorithm with a sorted ready queue. Put strongly connected components (cycles) last | libpg_query **17** syntax tree | **Yes**: the third tie-break key is the file path, compared with `localeCompare`, which also depends on the locale | PostgreSQL |
| **pg-delta** loader / new Supabase declarative flow | Lexicographic file order. Retry failed files in bounded rounds against a throwaway "shadow" database. pg-topo is only an optional pre-sort | PostgreSQL itself, by trial and error | **Yes** (see §3) | PostgreSQL |
| **pgschema** v1.13.3 | Loading: the order of `\i` includes, as written. Planning: its own topological sorts over a catalog snapshot | Catalog of a temporary schema | Yes, for loading | Apache-2.0 |
| **Atlas** (SQL schema) | "files and statements are ordered according to their dependencies" by the author. Files sort lexicographically; `atlas:import` sets explicit order | Dev database | Yes (manual) | Apache-2.0 core |
| **sqldef / psqldef** | Text parse with its own parser, then a stable Kahn sort. **On a cycle it gives up** and keeps the source order | No database | Ties keep the source order | MIT |
| **Tusker** | Alphabetical glob, executed in one transaction | Throwaway transaction | Yes | MIT / Apache-2.0 |
| **Supabase legacy (migra)** | Lexicographic order, or the explicit `schema_paths` list | Shadow database | Yes | n/a |
| **Stripe pg-schema-diff** | Lexical directory walk. Each file is executed **whole** ("would require fully parsing the SQL") | Temporary database | Yes | MIT |
| **Skeema** (MySQL) | Concurrent CREATEs with FK checks off. Statements that fail as *object-not-found* get one sequential retry | Workspace schema | Partly | Apache-2.0 |
| **Sqitch** / **Graphile Migrate** | Explicit: `--requires` declarations / `--!include` | n/a | No, but it is manual | MIT |
| **Bytebase SDL** (PG) | Documented as "topological sort". Supports only tables, indexes, views, sequences and functions; no triggers or policies | Not documented | Not verified | n/a |

### Notes and citations

**pg_dump** (REL_18_STABLE, `src/bin/pg_dump/pg_dump_sort.c`):
- `enum dbObjectTypePriorities` (≈L54–100) orders object types: TYPE, then FUNC, then … TABLE (views included), then ATTRDEF; then PRE_DATA_BOUNDARY; then CONSTRAINT, INDEX, RULE, TRIGGER, FK_CONSTRAINT, POLICY …; REFRESH_MATVIEW comes last. ACLs and comments have no priority of their own; they travel with their object.
- `sortDumpableObjectsByTypeName` presorts by priority, then namespace, then name.
- `TopoSort` is Knuth's algorithm with a heap. It works backwards and always takes the ready item that is latest in the presorted order, which "minimize[s] unnecessary rearrangement of the input ordering".
- `repairDependencyLoop` breaks loops in several ways: it splits out CHECK constraints and defaults, writes a view as a dummy view plus a separate rule, and postpones function bodies past the boundary. Foreign keys are *always* emitted separately as post-data `ALTER TABLE … ADD CONSTRAINT`.
- Its dependencies come from `getDependencies()` in `pg_dump.c`, which reads `pg_depend`.
- So pg_dump cannot order **source text**: the objects must exist first. It is the model for tie-breaking and loop-splitting, not a loader.

**pg-topo**:
- Source: npm tarball 1.0.0-alpha.8 and `supabase/pg-toolbelt/packages/pg-topo`. It is 4,896 lines of TypeScript in `src/`, about 3.7k in the core (`extract/` 2,278, `graph/` 775).
- `graph/build-graph.ts` handles references as follows:
  - An unresolved reference gives an `UNRESOLVED_DEPENDENCY` **warning only, and no edge**.
  - Signature-compatible overloads get edges to all candidates, but an edge that would close a cycle is silently skipped (`CYCLE_EDGE_SKIPPED`).
- `graph/topo-sort.ts` compares ready statements by phase weight, then statement class, then **file path (`localeCompare`)**, then statement index. Phases are tie-breaks only; cycles are emitted last, out of order.
- Supabase's own architecture document (`docs/architecture/target-architecture.md` §3.2, §4.4.1) calls pg-topo "advisory": the loader retries, and "the fix is the split, not the sort".

**Porting pg-topo to PG18 looks viable** (estimated a day or two, plus its test suite):
- `plpgsql-parser@18.5.14` already pins `libpg-query@18.1.5` and `@pgsql/types@^18`.
- `@pgsql/types` 17→18 changes are additive for DDL. For example, `Constraint` gains `is_enforced`, `without_overlaps` and `generated_kind`, and `CreateStmt` gains `nnconstraints`.
- Two traps:
  1. libpg_query 18 **excludes leading comments from statement slices** (`stmt_location` now points past them). pg-topo's `-- pg-topo:` annotations would silently stop being seen. The same applies to our `-- OVERRIDE DANGEROUS COMMAND:` marker (§4.4): it must be read from the gap between statements, not from the slice.
  2. The PL/pgSQL parse output was reworked in libpg_query 18.0.0.
- Even ported, pg-topo would need changing to meet our determinism rule: its file-path tie-break and its warn-and-drop handling of unresolved references would both have to go.

Other sources:
- pgschema: `internal/include/processor.go` (alphabetical `\i` folders), `internal/diff/topological.go`.
- Atlas: https://atlasgo.io/atlas-schema/sql.
- sqldef: `schema/ddl_ordering.go` (`topologicalSort`; on a cycle it returns empty and keeps the original order).
- Tusker: `crates/tusker/src/cli/schema/diff.rs`.
- Supabase: https://supabase.com/docs/guides/local-development/declarative-database-schemas.
- Stripe: `pkg/diff/schema_source.go`.
- Skeema: `internal/workspace/workspace.go` (`ExecLogicalSchema`).

Not verified: Atlas HCL semantics, Bytebase's actual algorithm, and Sqitch's licence.

**Conclusion from the survey:**
- No surveyed tool orders source text statically **and** guarantees that the result does not depend on file names.
- Static sorters (pg-topo, sqldef) fall back to source or path order on ties, cycles and unknown references.
- Catalog-based ordering (pg_dump) is deterministic, but it needs the objects to exist already.

## 2. The proof of concept

`prototype-schema-ordering/src/analyze.ts` (≈600 lines) works on `libpg-query@18` and `@pgsql/types`.

**1. Split.** `parseSync` each file. Slice each statement by its byte offsets (`stmt_location` / `stmt_len`) and keep `file:line` for error messages. Statements, not files, are the unit; a file is just a container.

**2. Extract provides and requires** with one walk over the syntax tree per statement:

| Statement | Provides | Requires (binds at CREATE) |
|---|---|---|
| `CREATE TABLE` | relation, row type, `uniq:t` (from PK/UNIQUE) plus the unique column sets, named constraints, `<t>_pkey` | column types, `%TYPE`, functions in defaults, checks and generated expressions, inline FK target **plus all of its unique keys** |
| `CREATE VIEW` / `MATERIALIZED VIEW` | relation, row type | every relation, function and type in the query. CTE names shadow relations |
| `CREATE TYPE … AS` / `CREATE DOMAIN` | type | attribute and base types, functions in checks |
| `CREATE FUNCTION` / `PROCEDURE` | `func:name` (identity includes the argument signature) | argument, return and default types. `BEGIN ATOMIC` / `RETURN` bodies: everything (bound and stored as a tree). `LANGUAGE sql` string bodies: the inner SQL is parsed, because `check_function_bodies = on` validates it at CREATE (it is re-bound at every call, so its overload choice is not frozen). **PL/pgSQL bodies are ignored: late-bound** |
| `CREATE INDEX` | index relation; unique keys if UNIQUE | table, functions in expressions and predicates |
| `CREATE TRIGGER` / `CREATE POLICY` | trigger / policy | table, the trigger function, `WHEN` / `USING` / `WITH CHECK` references (subqueries included) |
| `ALTER TABLE … ADD CONSTRAINT` | constraint; unique keys if PK/UNIQUE | table, FK target plus its unique keys, functions in checks |
| `'x'::regclass` / `regtype` / `regproc` literals | | the named object (resolved to an OID at CREATE) |
| `ENABLE`/`FORCE ROW LEVEL SECURITY`, `GRANT`/`REVOKE`, `COMMENT` | (decorations) | their target |

**3. Resolve.** Every requirement must match a statement's provides or a name in `pg_catalog`, read once from the live PG18 server. Otherwise it is a static **error** with `file:line`, raised before anything is loaded. References to other schemas are refused (spec §4.1). Duplicate definitions are errors.

**4. Edges.** A reference to function name `f` gets an edge from **every** overload of `f`. Every overload exists before anything that binds `f` at CREATE. A foreign key waits for every unique key of its target.

**5. Order.** Kahn's algorithm. The ready set is compared by:
1. phase (decorations are a hard final phase, as in pg_dump; nothing binds to a GRANT or COMMENT);
2. pg_dump-style kind priority (types, domains, tables, functions, views, constraints, indexes, triggers, policies);
3. **object identity** (`function pick(int4)`, `index parent_code_uidx` …);
4. the SHA-256 of the normalised statement text.

File and line only separate byte-identical duplicates. **File names never influence the order.**

**6. Cycles.** If Kahn's algorithm stops early, one cycle is reported with `file:line` and a tip. Example: "move one foreign key out of CREATE TABLE into ALTER TABLE … ADD CONSTRAINT", which is the allowed §4.1 form. Circular FKs written with `ALTER TABLE … ADD CONSTRAINT` need no special handling: the ALTER is its own statement and depends on both tables.

**7. Load.** The ordered statements run one pass, in **one transaction**, with `search_path = public, pg_catalog` and `check_function_bodies = on`. It fails fast with PostgreSQL's error and the statement's `file:line`. There are no retries.

**8. Lints** (candidates for static refusal, see §4):
- `OVERLOADED_REFERENCE`
- `SHADOWS_PG_CATALOG`
- `UNNAMED_INDEX` / `UNNAMED_CONSTRAINT`
- `FK_INDEX_CHOICE`: one column set has more than one unique index, and a foreign key references it.

Speed: static analysis plus ordering takes 0.3–17 ms per fixture. A synthetic 5,000-statement schema (6,998 edges) takes 234 ms to analyse and 92 ms to order (`src/scale.ts`).

## 3. PoC results

Each fixture was loaded:
- by our static order;
- in five *other* valid topological orders (the determinism guard, §4);
- with each file renamed and the statement order reversed (one file per statement, random names), to check file-name invariance;
- in **path order** (spec fallback: whole files in one pass);
- in **reverse path order**;
- by **pg-delta's `loadSqlFiles`** (library defaults).

"Same" means an identical catalog snapshot: `prototype-pg-delta/src/catalog.ts` plus every `pg_depend` binding (`pg_describe_object`, no OIDs) and the index each FK uses.

| Fixture | Ours (static order, one pass) | Guard (5 other valid orders) | Path order | Reverse path order | pg-delta loader |
|---|---|---|---|---|---|
| q35-shuffled (prototype-pg-delta; PG18 `VIRTUAL`, FK cycle via ALTER in a sub-folder) | ✅ 17 statements | ✅ 5/5 same | ❌ `relation "orders" does not exist` | ✅ same | ✅ same (4 rounds) |
| q35-overload-binding | ✅ view binds `pick(integer)` | ✅ 5/5 same | ⚠️ binds `pick(numeric)` | same as ours | ⚠️ `pick(numeric)` |
| overloads (view, `BEGIN ATOMIC` body, column default; `length(text)` shadowing pg_catalog) | ✅ `pick(integer)`, `fmt(integer)` ×2, `public.length` | ✅ 5/5 same | ⚠️ 19 catalog lines differ: `pick(numeric)`, `fmt(numeric)` ×2, `pg_catalog.length` | same as ours | ⚠️ same as path order |
| overload-ambiguous (`fmt(3)` with `fmt(numeric)` and `fmt(bigint)`) | ❌ **loud**: `function fmt(integer) is not unique` | n/a | ⚠️ silently binds `fmt(numeric)` | ⚠️ silently binds `fmt(bigint)` | ⚠️ loads in 1 round, in lexicographic (= path) order |
| domain-composite (domain over a composite type, composite arrays, `RETURN` bodies) | ✅ | ✅ 5/5 | ❌ | ✅ same | ✅ same (4) |
| view-chain (v3→v2→v1, matview + index, a CTE named like a real table) | ✅ | ✅ 5/5 | ❌ | ✅ same | ✅ same (4) |
| sql-functions (defaults calling SQL functions, `BEGIN ATOMIC`, procedure, `regclass` literal, a self-reading check via ALTER, a late-bound PL/pgSQL function) | ✅ | ✅ 5/5 | ❌ `function default_amount() does not exist` | ❌ `function owner_ok(text) does not exist` | ✅ same (2) |
| triggers-policies (trigger `WHEN`, policies calling functions and subqueries, RLS enable/force, table/column/function grants, `REVOKE`, 6 kinds of comments) | ✅ 23 statements | ✅ 5/5 | ❌ | ❌ `trigger "docs_audit" … does not exist` | ✅ same (3) |
| fk-index-choice (FK to `parent(code)`, which has a unique index **and** a unique constraint; self-reference FK; FK cycle via ALTER) | ✅ FK uses `parent_code_key` | ❌ **4/5 differ**: FK uses `parent_code_uidx` | ❌ | ❌ | ❌ stuck after 5 rounds: `e_tree.sql: relation "node" does not exist` |
| unnamed-index (two unnamed indexes on `t(a)`) | ✅ | ❌ **5/5 differ**: `t_a_idx` / `t_a_idx1` swap | ❌ | same as ours | ⚠️ names swapped compared with ours |
| extraction-gap (functional notation `c.order_count`; `%TYPE`) | ✅ (kind priority happens to hide the gap) | ❌ **4/5 fail**: `column c.order_count does not exist` | ❌ | same | same (3) |
| cycle-error (inline FK cycle; a default calling a `BEGIN ATOMIC` function that reads its own table) | ❌ static, before touching the database: `dependency cycle: table b (b.sql:1) -> table a (a.sql:2) -> …` + tip | n/a | ❌ | ❌ | ❌ stuck, with a similar tip |
| unresolved (type typo `moneyamount`, relation typo `ordrs`, plus a PL/pgSQL reference to a missing table) | ❌ static: **both** typos reported with `file:line`; the PL/pgSQL reference is correctly not flagged | n/a | ❌ first error only | ❌ | ❌ stuck after 2 rounds |

**File-name invariance:** for all 11 fixtures that pass analysis, renaming every file and reversing the statement order gives **the same statement order**.

What the table shows:

1. **Static ordering works on everything §4.1 allows that was tried.** That includes PG18 syntax: the parser is PG18, unlike pg-topo's PG17.
   - 10 of the 11 fixtures that pass analysis loaded in one pass and one transaction, with no retries. The 11th, `overload-ambiguous`, was refused by PostgreSQL on purpose (point 2).
   - Path order failed 8 of those 11; these fixtures were deliberately named against dependency order.
   - pg-delta's loader loaded 10 of 11, but 3 of the 10 gave a different catalog from ours (overload and unnamed-index fixtures).
2. **The all-overloads rule turns silent order-dependence into either determinism or a loud error.**
   - With every overload created first, PostgreSQL resolves calls against the complete schema. In `overload-ambiguous` it *refuses* the ambiguous call.
   - Path order and pg-delta silently froze whichever overload existed at the time. Path order and reverse path order disagreed (`fmt(numeric)` vs `fmt(bigint)`).
   - **Ablation** (edges to only one overload): the guard showed the result changing with load order in 4 of 5 alternative orders in each overload fixture.
3. **pg-delta's loader (without pg-topo) cannot reorder statements *within* a file.**
   - In `fk-index-choice/e_tree.sql`, an `ALTER TABLE node …` comes before `CREATE TABLE node` in the same file. The loader failed identically for 5 rounds.
   - Its results also depend on file names, in the overload and unnamed-index fixtures.
4. **Some order-dependence exists that no dependency edge can remove.** In each case the two statements are independent of each other, yet the catalog depends on which runs first:
   - **Generated names:** two unnamed indexes both want `t_a_idx`.
   - **FK index choice:** `transformFkeyCheckAttrs` (`src/backend/commands/tablecmds.c` L13521, REL_18_STABLE) takes the *first* qualifying unique index from `RelationGetIndexList`. That list is "guaranteed to be sorted in order by OID" (`relcache.c` L4820), i.e. by creation order.

   Our content-based tie-break makes both deterministic (same files → same catalog). But the result is decided by our tie-break rule, which the author cannot see, and which a future super-deploy version might change.
5. **Extraction gaps are the main risk of a static sorter.** Functional notation (`c.order_count` meaning `order_count(c)`) is not visible as a function call. Here the gap was hidden by luck of kind priority, and surfaced only through the guard. A gap normally fails loudly, with PostgreSQL's error at a `file:line`. It could be *silent* only if the missed reference is one whose binding depends on order, as overloads are.

## 4. Determinism guard

### Dynamic guard (tried)

After the normal load, load the same statements into a second throwaway database in a different **valid** topological order. Then compare the two catalogs, including `pg_depend` bindings and FK index choice. Any difference, or a failure in the alternative order, means the desired schema is order-dependent: refuse it and show the differing catalog lines.

| Alternative order | What it caught |
|---|---|
| `reverse`: same kind priority, content tie-break reversed | unnamed-index, overloads-ablation. **Missed** fk-index-choice, extraction-gap and q35-overload-binding-ablation |
| `reverse-ignore-priority`: kind priority dropped, content reversed | **Every** order-dependent case: unnamed-index, fk-index-choice, extraction-gap, both ablations |
| 3 random valid orders | Each caught all but at most one case |
| On the 7 order-independent fixtures | 0 false positives across 35 alternative loads |

- **Cost:** one extra load and two catalog snapshots per check. Each fixture load took milliseconds here.
- **Limit:** it samples orders; it does not prove independence. Two linear extensions cannot flip every pair of independent statements.
- **Possible upgrade:** for the classes known to interact (same table's indexes, same function name, same unique column set), add targeted pairwise flips.
- **Payoff:** a desired schema that passes the guard has a catalog that is independent of file names *and* of super-deploy's own tie-break rule. That also protects rehearsals and drift checks against a future change to the sorter.

### Static refusal (instead of, or as well as, the guard)

With spec §4.1 refusing custom casts, operators, aggregates and extra schemas, user objects can influence name resolution at CREATE time in only a few ways. Each can be found statically:

| Class | Statically detectable? | Handled by ordering alone? | Possible rule |
|---|---|---|---|
| Overloaded user function referenced where binding is frozen (view, default, check, generated column, index, policy, trigger `WHEN`, `BEGIN ATOMIC`) | Yes: the name has more than one `CREATE FUNCTION` | **Yes**, with the all-overloads edges: deterministic, or PostgreSQL refuses it as ambiguous | Optional: refuse user overloads entirely, for clarity |
| A user function, type or relation **shadowing a `pg_catalog` name** (`search_path = managed, pg_catalog` lets it capture calls) | Yes: compare with `pg_catalog` names | Yes, with edges | Optional: refuse (cheap and complete) |
| Implicit casts | Built-in only (custom casts are refused) | Not order-dependent | none needed |
| Unqualified call where resolution is genuinely ambiguous | **Not statically**: it needs the expression types PostgreSQL's resolver uses | PostgreSQL errors once all overloads exist | Rely on that error |
| Unnamed index / unnamed `ADD CONSTRAINT` | Yes | **No** (independent statements) | Refuse: require explicit names |
| More than one unique index or constraint on the same column set referenced by an FK | Yes (column sets) | **No** | Refuse |
| Extraction gaps (functional notation, anything the walker misses) | No, by definition | No | Only the dynamic guard (or a loud load failure) catches them |

So static refusal can close every *known* class at near-zero cost. Unknown extraction gaps still need either the dynamic guard or acceptance that they show up only as loud load failures.

## 5. Failure modes and limits found

- **Functional notation** (`row.func`) and any other reference shape the walker does not model. The PoC models `RangeVar`, `FuncCall`, `TypeName` (`%TYPE` included), `TypeCast` to `reg*` and FK `pktable`. A production extractor needs a test corpus per §4.1 object type, including:
  - exclusion constraints with operator classes;
  - virtual and stored generated columns;
  - `RETURNS TABLE`;
  - column-level grants;
  - comments on every object kind;
  - domain constraints;
  - `WITHOUT OVERLAPS`, PG18 named `NOT NULL`.
- **CTE shadowing** is approximated: any unqualified relation name matching *any* CTE in the statement is treated as the CTE. In the worst case this drops an edge, which surfaces as a loud load failure or a guard hit.
- **PL/pgSQL is ignored for ordering**, which is correct because it is late-bound. The function's existence still orders triggers. Its body references are still subject to the §4.3 rules, which are a separate check.
- **Generated names** (`t_pkey`, `t_a_key`) are approximated, and only used to attach comments. Decorations run last, so this is never needed for order.
- **Cycles** that PostgreSQL itself cannot create, such as a default calling a `BEGIN ATOMIC` function that reads the same table, are reported statically with a tip. The fix is always one of: `ALTER TABLE … ADD CONSTRAINT`, or making the function PL/pgSQL.
- **Error locations** must name `file:line`, because statements from different files interleave. The PoC does.
- **libpg_query 18 leaves leading comments out of statement slices.** This matters for §4.4 override markers (see §1).

## 6. Effort estimate for a production version

These are estimates, not measurements.

- **Parser use.** The §4.1/§4.2 allowlist already needs `libpg-query@18` and a walk over the syntax tree, so the splitter and walker would be shared with rule enforcement. No new dependency: pg-topo and its PG17 parser are not needed.
- **Size.** ≈1.5–2.5k lines of TypeScript for splitting, extraction across every §4.1 kind, resolution against `pg_catalog`, ordering with a heap, cycle messages and lints. Plus the guard (≈150 lines, reusing the rehearsal adapter's throwaway databases and the `catalog.ts`-style snapshot that the pg-delta verdict already requires). For comparison, pg-topo is 4.9k lines, but it is general: multiple schemas, roles, extensions and more.
- **Tests.** A fixture corpus of about 60–100 cases (one or more per object kind and per reference shape, plus the order-dependence classes above), each run with the guard against real PG18.
- **Time.** Roughly 2–3 weeks for one developer, including the corpus. A maintenance cost recurs with each PostgreSQL major version (new syntax means new reference shapes), the same kind of cost the allowlist already carries.

## 7. Options for the user (not decided)

- **A. Static statement ordering plus the dynamic guard.** No naming convention.
  - This is the only option tried that meets both requirements of the question: the order is a pure function of statement content, and the guard proves (by sampling) that the catalog does not depend on it.
  - One-pass, one-transaction loading, so a rehearsal and a drift check rebuild exactly the same desired schema. Typos and cycles are reported before anything runs, with `file:line`.
  - Costs: a module of about 2k lines plus a corpus that we own; one extra throwaway load per `draft`/rehearsal; extraction gaps show up as guard refusals that the author must work around.
- **A′. Option A with static refusals instead of (or as well as) the guard.**
  - Require index and constraint names. Refuse FK targets whose column set has more than one unique key. Optionally refuse user function overloads and names that shadow `pg_catalog`.
  - Cheaper at run time and easier to explain. It does not catch unknown extraction gaps; those fail loudly at load, or rarely (only for order-dependent bindings) silently.
- **B. Path order with numbered prefixes** (current spec fallback).
  - Simple, visible, one pass, PostgreSQL's own errors.
  - But the catalog **does** depend on file names: the overload fixtures bind differently under path and reverse path order. So it is deterministic for fixed names, not independent of them.
  - It could be combined with the static lints and refusals above to close the known classes. The static sorter could also be used only to *suggest* a reordering when a file fails (option D in the pg-delta report).
- **C. pg-delta's loader** (lexicographic plus retry).
  - Handles arbitrary file names and gives good stuck-file errors.
  - But its results depend on file names (overload, unnamed-index), it cannot reorder within a file without pg-topo (`fk-index-choice`), and it adds a second coupling to pg-delta.
- **D. Port pg-topo to `libpg-query@18`.**
  - Viable, with a PostgreSQL licence, but it would need its file-path tie-break and its warn-and-drop handling of unresolved references changed to meet our rule, and annotation handling fixed for the PG18 comment change.
  - At that point it is about as much work as option A, for a larger and more general codebase.

Whatever is chosen, the prototype supports one cheap rule: refuse unnamed indexes and constraints, and FK targets with duplicate unique keys. Neither dependency ordering nor path order makes those order-independent.
