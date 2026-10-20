# Research: SQL parsers, schema differs, embedded PG18 for Node

Compiled 2026-10-19 from the npm registry, GitHub API/READMEs and vendor docs. "Latest" means the latest published version or release on that date. Items marked **(unverified)** were not confirmed in a primary source.

Background on PG18 grammar: PG18 adds new syntax. Examples are virtual generated columns, `WITHOUT OVERLAPS` / `PERIOD` temporal keys, `NOT ENFORCED` constraints, `NOT NULL … NOT VALID`, and `OLD`/`NEW` in `RETURNING`. A parser built on the PG ≤17 grammar rejects or mis-parses these statements. Only libpg_query **18.x** builds parse them.

---

## A. SQL parsers usable from Node/TS

| Package | Latest (date) | PG grammar | Runtime | OS story | Typed AST | Deparse | Licence | Maintenance | Size (unpacked) |
|---|---|---|---|---|---|---|---|---|---|
| [`libpg-query`](https://www.npmjs.com/package/libpg-query) ([repo](https://github.com/constructive-io/libpg-query-node), ex-launchql) | 18.1.5 (2026-09-17) | **18** (dist-tags `pg13`…`pg18`. The first PG18 build was 18.0.0 on 2026-05-22) | **WASM only**, no node-gyp | Same artifact on Win/macOS/Linux and in the browser. Also `pg18-lowmem-{16,32,64}` tags for smaller WASM memory | via `@pgsql/types@pg18` (generated from the PG protobuf) | No (parse, parseSync, parsePlPgSQL, scan, fingerprint, normalize; the full API exists only on pg18) | MIT (wraps BSD-3 libpg_query) | Active (repo pushed 2026-10-03) | 1.8 MB (`.wasm` 1.72 MB) |
| [`pgsql-parser`](https://www.npmjs.com/package/pgsql-parser) + [`pgsql-deparser`](https://www.npmjs.com/package/pgsql-deparser), `@pgsql/types`, `@pgsql/utils`, `@pgsql/traverse`, `plpgsql-parser`, `@pgsql/transform` ([repo](https://github.com/constructive-io/pgsql-parser)) | parser 18.2.12 / deparser 18.3.12 (2026-10-13) | **18** (tags pg13…pg18) | parse = libpg-query WASM; **deparser is pure TS** (no WASM) | All OSes | Yes (`@pgsql/types`, `@pgsql/utils` builders, `walk()` visitors incl. PL/pgSQL) | **Yes**: a TS reimplementation, "battle-tested against 23,000+ statements". It is not the C deparser, so round-trip fidelity is the library's claim | MIT | Very active (weekly releases) | parser 13 KB + deparser 1 MB + libpg-query 1.8 MB |
| [`@pgsql/parser`](https://www.npmjs.com/package/@pgsql/parser) | 1.5.0 (2026-05-22) | runtime-selectable 15–18 ("LTS" build 15–17) | WASM | All OSes | via `@pgsql/types` | No | MIT | Active | 6.9 MB (all versions) |
| [`@supabase/pg-parser`](https://www.npmjs.com/package/@supabase/pg-parser) ([repo](https://github.com/supabase-community/pg-parser)) | 0.1.7 (2026-02-10) | **15, 16, 17 only** (runtime-selectable, default 17). **No PG18** | WASM (real C parser **and C deparser**) | All OSes + Deno/Bun/browser | Yes (typed, discriminated results) | **Yes** (C `pg_query_deparse`, also node fragments) | MIT (npm) | Slow; pre-1.0, last push 2026-06 | 5.3 MB |
| [`@pg-nano/pg-parser`](https://www.npmjs.com/package/@pg-nano/pg-parser) ([repo](https://github.com/pg-nano/pg-parser)) | 16.1.5 (2024-11-07) | **16** | **Native N-API addon** (prebuild-install) | Prebuilds only for darwin-arm64/x64, linux-x64, linuxmusl-x64. **No Windows prebuild, so node-gyp and MSVC are needed** | Yes ("100% type-safe AST", `walk`) | No | MIT (npm) | Dormant (last push 2024-12) | 385 KB + binary |
| [`pg-query-emscripten`](https://www.npmjs.com/package/pg-query-emscripten) ([repo](https://github.com/pganalyze/pg-query-emscripten)) | 5.1.0 (2024-09-04) | 16-era libpg_query | asm/WASM (emscripten) | All | No (raw JSON) | No | MIT | Dormant | 4.6 MB |
| [`pgsql-ast-parser`](https://www.npmjs.com/package/pgsql-ast-parser) | 12.0.2 (2026-01-27) | Hand-written partial grammar, **not PG's** | pure JS | All | Yes | Yes (toSql) | MIT | Low | — |
| Upstream [`pganalyze/libpg_query`](https://github.com/pganalyze/libpg_query) (C) | 18.1.0 (2026-09-30). 17-6.2.5 the same day | 13–18 | C (Go: `pg_query_go`, Rust: `pg_query.rs`) | — | protobuf | C deparser | BSD-3 | Active | — |

**Takeaway:** for PG18 grammar in Node, the only maintained choice today is **`libpg-query@18` with `@pgsql/types@18` (and `pgsql-deparser@18` if deparse is needed)**. All of them are WASM, so they need no build tools on Windows. If an allowlist only needs to check statement node types (`stmts[].stmt` has a single key like `CreateStmt`, `AlterTableStmt`, `IndexStmt`, …), `libpg-query` plus `@pgsql/types` is enough. `plpgsql-parser` / `@pgsql/traverse` can also walk function bodies. Supabase's parser lacks PG18. pg-nano is PG16, native, and has no Windows binary.

---

## B. Declarative schema differs

Legend for the desired-state model:
- **Shadow**: apply the desired SQL to a temporary or real Postgres, then introspect `pg_catalog`.
- **Static**: parse the SQL text without a database.
- **2-DB**: diff two live databases.

| Tool | Lang | Latest (date) | Desired-state model | PG18 | Dep-sorted output | Embed from Node / distribution | Licence | Status |
|---|---|---|---|---|---|---|---|---|
| [stripe/pg-schema-diff](https://github.com/stripe/pg-schema-diff) | Go | v1.0.9 (2026-08-06) | Shadow (temp DB on the same server via `tempDbFactory`). Plans are also *validated* on a temp DB | **No**: README/CI list 14–17 | Yes (dependency graph). Open bugs on policy ordering (#266, #308) | Go lib or CLI. Install via brew / `go install`; **no prebuilt release binaries**, Windows not mentioned. Node would need a child-process call | MIT | Active but slow ("limited cycles"). Domains PR open (#306) |
| [pgplex/pgschema](https://github.com/pgplex/pgschema) ([docs](https://www.pgschema.com)) (Bytebase) | Go | v1.13.3 (2026-10-15) | Shadow: an **embedded Postgres** via `fergusstrange/embedded-postgres` (zonky binaries), or an external `--plan-*` DB. No SQL parser dependency | **Yes**: "versions 14–18" | Yes ("proper dependency ordering") | Prebuilt for linux amd64/arm64 and darwin amd64/arm64, plus deb/rpm/Docker. **Windows explicitly unsupported (use WSL)**. No npm package | Apache-2.0 | Very active |
| [supabase/pg-delta](https://github.com/supabase/pg-toolbelt) (`@supabase/pg-delta`, monorepo `pg-toolbelt`) | **TypeScript** | 1.0.0-alpha.59 (2026-10-12). `latest` tag is a 0.0.0 placeholder | Shadow (`schema apply --dir` loads `.sql` files into a shadow, then extracts the catalog). Also 2-DB. "Let PostgreSQL be the only thing that understands PostgreSQL" | **Yes**: proven on a 331-scenario corpus across 14–18 | Yes. One fact-level dependency graph and "one deterministic sort", plus a **`prove`** step (apply to a clone, re-extract, compare) | **npm package, Node ≥20 (also Bun/Deno)**, deps are only `pg`, `debug`, `pg-connection-string`. Library API (`extract`, `plan`, `apply`). Needs a reachable real PG for the shadow. **PGlite explicitly rejected** "for version/extension parity" | PostgreSQL (repo), MIT (npm metadata) | Very active. Breaking-change alpha. Now the default `supabase db diff` engine for new projects |
| [`@supabase/pg-topo`](https://www.npmjs.com/package/@supabase/pg-topo) | TS | 1.0.0-alpha.8 (2026-10-06) | Static (libpg-query WASM AST) | depends on `@pgsql/traverse@17`, so **PG17 grammar** | Topo-sorts statements in declarative files ("advisory", cycles-last) | npm | ISC | Alpha |
| [djrobstep/migra](https://github.com/djrobstep/migra) + [schemainspect](https://github.com/djrobstep/schemainspect) | Python | no releases. Pushed 2025-08 / 2024-05 | 2-DB (catalog) | No (untested) | Partial (known ordering bugs) | Python/pip | Unlicense | **Deprecated** ("DEPRECATED" in repo title) |
| [`@pgkit/migra`](https://www.npmjs.com/package/@pgkit/migra) + `@pgkit/schemainspect` ([repo](https://github.com/mmkal/pgkit)) | TS | 0.6.1 (2025-08-30) | 2-DB (catalog queries ported from schemainspect) | No (untested) | Inherits migra's ordering | npm, pure TS (tRPC CLI, zod) | Apache-2.0 | Low activity (repo push 2026-04). "Port of an unmaintained library" |
| [sqldef / psqldef](https://github.com/sqldef/sqldef) | Go | v3.11.26 (2026-10-01) | **Static**: own yacc parser (vitess-derived) with `pg_query_go/v6` (PG17) as a dependency. Current state comes from live DB introspection or a `.sql` file (offline file-to-file mode) | CI matrix covers PG 13 and **18** | Limited | **Prebuilt binaries incl. `psqldef_windows_amd64.zip`**, darwin amd64/arm64, linux amd64/arm64/386/arm. The npm wrapper [`sqldef`](https://www.npmjs.com/package/sqldef) 0.0.2 (2025-01) is stale | MIT (parser Apache-2.0) | Very active |
| [Atlas (ariga)](https://github.com/ariga/atlas) ([features](https://atlasgo.io/features)) | Go | v1.3.0 (2026-08-02) | Shadow ("dev database", usually Docker) | Not documented. The OSS CI tests PG 10–15 only | Yes | Prebuilt binaries for all 3 OSes. No npm package | Apache-2.0 Community Edition. **Views, matviews, functions, procedures, triggers, sequences, domains, composite types, RLS, extensions, partitions are Pro (paid/login)** | Very active (commercial) |
| [Tusker](https://github.com/bikeshedder/tusker) | Rust (rewrite of the Python original) | tusker-v0.8.0 (2026-10-02) | Shadow: builds the schema files and the migrations into temp DBs and diffs them (**the same workflow super-deploy wants**) | **Yes**: CI runs 16, 17, 18. Handles PG18 named NOT NULL constraints | Partial (routines only, deterministic constraint order) | Release binary linux-x86_64-musl only. cargo / ghcr image | Apache-2.0 / MIT | Active, small (18★) |
| [pgquarrel](https://github.com/eulerto/pgquarrel) | C | 0.7.0 (2020-02-26) | 2-DB (catalog) | No | Partial | Build from source | BSD-3 | Dormant (last push 2023) |
| [apgdiff](https://github.com/fordfrog/apgdiff) | Java | no releases. Last push 2024-01 | Static (parses pg_dump output) | No (old grammar) | Weak | JVM | MIT | Dormant |
| Prisma `migrate diff` (reference) | Rust schema-engine + TS CLI | prisma 8.0.0-rc.23 / 7.10.1 (2026-10) | Prisma schema DSL, or migrations replayed into a **shadow DB** | — | Yes | npm (engine binary) | Apache-2.0 | Active. Tables, enums, indexes, FKs, views (preview); no functions/triggers/RLS |
| Drizzle-kit (reference) | TS | 0.31.11 (2026-09-21). v1 in beta | Static: TS schema to JSON snapshot diff. Introspection only for `pull` | — | Yes | npm, pure TS | MIT | Active. Renames resolved via interactive prompts |

### Object-kind coverage (✅ diffed, ◐ partial, ❌ no, ? unclear)

| Kind | pg-schema-diff | pgschema | pg-delta | migra/@pgkit | psqldef | Atlas OSS / Pro | Tusker 0.8 |
|---|---|---|---|---|---|---|---|
| Tables/columns | ✅ | ✅ (identity, generated, LIKE) | ✅ | ✅ | ✅ | ✅/✅ | ✅ / ◐ (generated cols) |
| Constraints (PK/FK/UQ/CHECK/EXCL) | ✅ (online NOT VALID → VALIDATE) | ✅ | ✅ | ✅ | ✅ | ✅/✅ | ◐ |
| Indexes | ✅ (CONCURRENTLY, online replace) | ✅ | ✅ (`concurrentIndexes` option) | ✅ | ✅ | ✅/✅ | ✅ |
| Views / matviews | ✅ / ✅ (recent) | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ❌/✅ | ❌ |
| Functions / procedures | ✅ / ✅ | ✅ / ✅ (+aggregates) | ✅ / ✅ (+aggregates) | ✅ / ? | ◐ (`manage.function`) | ❌/✅ | ✅ / ✅ |
| Triggers | ✅ | ✅ (constraint triggers) | ✅ (+event triggers, rules) | ✅ | ◐ | ❌/✅ | ✅ |
| Sequences | ✅ | ✅ | ✅ | ✅ | ◐ | ❌/✅ | ✅ |
| Enums | ✅ | ✅ (in-place add) | ✅ | ✅ | ✅ (+rename value) | ✅/✅ | ✅ |
| Domains | ❌ (PR #306) | ✅ | ✅ | ◐ | ❌ | ❌/✅ | ✅ |
| Composite / range types | ❌ ("only enums") | ✅ composite | ✅ both (attribute-level) | ◐ | ❌ | ❌/✅ | ❌ |
| RLS policies | ✅ | ✅ | ✅ | ✅ | ✅ | ❌/✅ | ❌ |
| Grants | ◐ (table; column/routine/view ACL PRs open) | ✅ (incl. column, default privileges) | ✅ (acldefault-normalized, default privileges) | ✅ (opt-in) | ◐ (`managed_roles`) | ?/◐ | ❌ |
| Comments | ❌ | ✅ | ✅ (any target) | ? | ✅ (table/column/index) | ✅/✅ | ❌ |
| Extensions | ✅ | ❌ (explicitly unsupported) | ✅ | ✅ | ✅ | ❌/✅ | ✅ |
| Partitions | ✅ ("strong") | ✅ | ✅ | ✅ | ✅ (skippable) | ❌/✅ | ❌ |
| Roles / ownership | ❌ | ❌ (OWNER TO ignored) | ✅ roles, memberships, owners | ◐ | ◐ | Pro | ❌ |
| Extras | hazards system, lock/statement timeouts | plan JSON, lock timeouts | publications, subscriptions, FDW, collations, security labels; `_custom/` escape hatch for unmodeled objects | — | `@renamed` annotations | lint/cloud | migration runner |

### Notable limitations

- **Renames.** pg-schema-diff and pgschema treat a rename as drop + add, so data can be lost. psqldef supports explicit `-- @renamed from=` annotations for tables, columns, indexes, enum types and values. pg-delta reports "rename candidates". Drizzle-kit asks interactively. No catalog differ can detect a rename on its own, because names are the identity.
- **Column order.** No tool reorders columns (PG has no `ALTER … POSITION`). Diffs ignore column order, or would need to rebuild the table.
- **Windows.** Of the shadow-based tools, only Atlas and pg-delta (pure TS) run on Windows. pgschema refuses Windows, pg-schema-diff ships no binaries, and Tusker ships Linux binaries only. psqldef has a Windows binary but uses static parsing.
- **Determinism.** pg-delta advertises one deterministic sort plus a convergence proof. pg-schema-diff has open ordering bugs. migra has known ordering issues.

---

## C. Throwaway PostgreSQL 18 for Node (Win/macOS/Linux)

| Option | Latest (date) | PG18? | Platforms | Mechanism | Size | Fidelity for catalog introspection / DDL | Notes |
|---|---|---|---|---|---|---|---|
| [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) + `@embedded-postgres/<platform>` ([repo](https://github.com/leinelissen/embedded-postgres)) | 18.4.0-beta.17 (2026-06-05). The version encodes the PG version. Everything is tagged "beta" | **Yes, 18.4** (14.23–18.4 published). Lags upstream (zonky has 18.6) | darwin x64/arm64, **windows-x64**, linux x64/arm/arm64/ia32/ppc64. **No windows-arm64** | Real `initdb` + `postgres` processes from npm optionalDependencies (pnpm installs only the host platform) | Large: linux-x64 59 MB, windows-x64 109 MB, darwin-arm64 148 MB unpacked | Full: real server, multi-connection, real catalogs, contrib extensions bundled | MIT wrapper, binaries Apache-2.0 (zonky-derived). Cannot run as root unless `createPostgresUser`. Release cadence about every 2 months |
| [zonky embedded-postgres-binaries](https://github.com/zonkyio/embedded-postgres-binaries) | v18.6.0 (2026-08-28) | **Yes, 18.6** | Darwin, Windows, Linux, Alpine; amd64/i386/arm32/arm64/ppc64le | Maven jars containing `.txz` archives (trimmed "~10 MB") | small | Full server | Apache-2.0. The upstream of embedded-postgres (npm) and fergusstrange (Go, used by pgschema). Fetching from Maven Central at runtime is possible |
| [theseus-rs/postgresql-binaries](https://github.com/theseus-rs/postgresql-binaries) | 18.6.1 (2026-10-18) | **Yes, 18.6** | x86_64 and **aarch64** for Linux gnu/musl, macOS, **Windows (incl. arm64)** | GitHub release tarballs with SBOM/provenance | full builds | Full server | PostgreSQL licence. Good source for on-demand download plus checksum pinning if we skip npm |
| [PGlite](https://www.npmjs.com/package/@electric-sql/pglite) (`@electric-sql/pglite`) | 0.5.10 (2026-10-14) | **Yes**: 0.5.0 moved to PG 18.3, 0.5.9 to **18.6** | Anywhere JS runs (WASM) | Postgres compiled to WASM, running in **single-user mode, single connection** (`pglite-socket` exposes the wire protocol to one client at a time) | 35 MB unpacked (~3 MB gzipped core). Extensions are separate packages | Real PG catalogs and `pg_get_*def`, so DDL semantics are genuine. Caveats: single connection (no concurrent sessions, so `CREATE INDEX CONCURRENTLY` and lock behaviour cannot be rehearsed realistically **(unverified)**); only WASM-ported extensions; limited locale/ICU **(unverified)**. pg-delta's maintainers rejected it "for extension and version parity" | Apache-2.0. Very active. Fastest startup and no binaries, so it could serve as a fast path for parse/validate rehearsals |
| [Testcontainers](https://www.npmjs.com/package/@testcontainers/postgresql) (`@testcontainers/postgresql`) | 12.2.1 (2026-10-13) | Yes (`postgres:18` image, any tag) | Wherever Docker runs (Docker Desktop on Windows/macOS) | Docker container | image pull | Full and exact (any image, including extension images) | MIT. **Requires Docker**, which is a heavy prerequisite for a CLI. Fine for CI and as a "bring your own server" option |
| User-supplied server (`--shadow-url`) | — | Any | Any | Template DB clone (`CREATE DATABASE … TEMPLATE`) | — | Exact match with production version and extensions | The pattern pg-delta, pgschema (`--plan-*`), Atlas (`--dev-url`) and Prisma (shadow) all support |

---

## D. Recommendation: build our own differ, or wrap one?

### Options compared

| Criterion | Wrap pgschema | Wrap pg-schema-diff | Wrap psqldef | Embed `@supabase/pg-delta` | **Build our own (two throwaway DBs, introspect `pg_catalog`)** |
|---|---|---|---|---|---|
| PG18 | ✅ | ❌ (14–17) | ◐ static parser (PG17 pg_query) | ✅ (14–18 corpus) | ✅ (we control queries) |
| Windows | ❌ | ❌ no binaries | ✅ | ✅ (pure TS) | ✅ |
| Node integration | child process + Go binary per OS | needs a Go build per OS | child process | **native library** | native |
| Fidelity model | shadow (good) | shadow (good) | static parse (weakest) | shadow + proof (best) | shadow (good) |
| Determinism | good | ordering bugs open | ok | explicit deterministic sort | ours to guarantee |
| Coverage | broad (no extensions/owners) | narrow (no domains/composites/comments) | narrow | broadest | grows incrementally |
| Risk | Windows blocker | PG18 + Windows blockers | fidelity | alpha API churn, Supabase-driven roadmap | large effort (pg-delta: ~23k LOC engine) |

### Recommended approach

1. **Desired-state model: shadow databases, not static parsing.** Apply previous-migration SQL to DB A and desired SQL to DB B, then diff the catalogs. Every serious tool converged on this: pgschema dropped its parser, and pg-delta calls static analysis "approximate". Use the parser only for the **deploy-time allowlist**: `libpg-query@18` plus `@pgsql/types@18`, WASM, so no Windows build tools are needed.
2. **Throwaway PG18: `embedded-postgres@18.x`** (real binaries, all three desktop OSes, and pnpm installs only the host platform), with a `--shadow-url` escape hatch for exact prod parity or extensions. Testcontainers is the CI option. Avoid PGlite as the source of truth, but consider it later as a fast pre-check. Note that embedded-postgres trails upstream minors and is perpetually "beta"; pinning a version, or downloading theseus-rs/zonky archives with checksums, is a fallback.
3. **Differ: prototype against `@supabase/pg-delta` first** (TS, Node ≥20, PG18-proven, deterministic sort, convergence `prove`, Windows-safe since it only needs `pg`). Pin an exact alpha and wrap it behind our own `Differ` interface. If its alpha churn, the 4.8 MB footprint, or Supabase-specific assumptions hurt, **build our own catalog differ** behind the same interface. Scope it to tables, columns, constraints, indexes, views, functions, triggers, sequences, enums, domains, policies, grants and comments. Use `pg_get_*def()` for bodies and `pg_depend` for one topological sort with deterministic tie-breaking (kind, schema, name). Use pg-delta's COVERAGE.md and pgschema's object table as the checklist.
4. **Verify every generated migration the way pg-delta does:** apply migration(prev) to a fresh DB, re-introspect, and require an empty diff against desired. This is cheap with throwaway DBs and catches ordering and differ bugs regardless of which engine we pick.
5. **Renames and column order:** neither can be inferred safely. Require explicit annotations or hand-written migration steps, as psqldef's `@renamed` does, and treat column order as non-semantic.

### Key sources

[libpg-query-node](https://github.com/constructive-io/libpg-query-node) · [pgsql-parser](https://github.com/constructive-io/pgsql-parser) · [libpg_query releases](https://github.com/pganalyze/libpg_query/releases) · [supabase pg-parser](https://github.com/supabase-community/pg-parser) · [pg-nano/pg-parser](https://github.com/pg-nano/pg-parser) · [pg-schema-diff](https://github.com/stripe/pg-schema-diff) · [pgschema](https://github.com/pgplex/pgschema), [unsupported](https://www.pgschema.com/syntax/unsupported), [installation](https://www.pgschema.com/installation), [plan-db](https://www.pgschema.com/cli/plan-db) · [pg-toolbelt / pg-delta](https://github.com/supabase/pg-toolbelt) (`packages/pg-delta/COVERAGE.md`, `docs/overview.md`, `docs/architecture/target-architecture.md`) · [supabase db diff](https://supabase.com/docs/reference/cli/supabase-db-diff) · [sqldef](https://github.com/sqldef/sqldef) (`cmd-psqldef.md`) · [Atlas features](https://atlasgo.io/features) · [Tusker](https://github.com/bikeshedder/tusker) · [migra](https://github.com/djrobstep/migra) · [pgkit](https://github.com/mmkal/pgkit) · [pgquarrel](https://github.com/eulerto/pgquarrel) · [apgdiff](https://github.com/fordfrog/apgdiff) · [embedded-postgres](https://github.com/leinelissen/embedded-postgres) · [zonky binaries](https://github.com/zonkyio/embedded-postgres-binaries) · [theseus-rs binaries](https://github.com/theseus-rs/postgresql-binaries) · [PGlite](https://github.com/electric-sql/pglite) (CHANGELOG) · [testcontainers-node](https://github.com/testcontainers/testcontainers-node)
