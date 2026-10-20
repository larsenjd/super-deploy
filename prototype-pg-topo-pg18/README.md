# prototype-pg-topo-pg18 (THROWAWAY)

Spike: does `@supabase/pg-topo` support PostgreSQL 18, and how does it compare with the schema-ordering PoC (Q35)? Not production code: no tests, no polish. Delete it when it has served its purpose.

Run from the repo root (Node 24, pnpm):

```
pnpm prototype:pg-topo-pg18
```

It installs three folders (`prototype-schema-ordering/` for the PoC it compares against, this folder, and `pg18-override/`), starts a private PostgreSQL 18 cluster through `embedded-postgres` in `prototype-pg-topo-pg18/.pgdata-wipe-me/`, and creates only databases named `prototype_pg_topo_pg18_wipe_me*`. It writes `output/console.txt` and `output/results.json`, then stops the cluster and deletes the data directory. A run takes about a minute.

Two pg-topo variants are tested:

| Variant | What it is |
|---|---|
| `stock alpha.8` | `@supabase/pg-topo@1.0.0-alpha.8` (newest published) as published. Its parser chain resolves to `plpgsql-parser@0.5.16` → `@libpg-query/parser@17.6.10` (PG17 grammar), `@pgsql/traverse@17.2.6` |
| `alpha.8 + PG18 overrides` | The same tarball, with `plpgsql-parser@18.5.14` (→ `libpg-query@18.1.5`) and `@pgsql/traverse@18.7.14` forced through pnpm `overrides` (`pg18-override/pnpm-workspace.yaml`). Upstream does not ship this; it is a cheap "is a port just a dependency bump?" experiment |

| File | What it does |
|---|---|
| `src/cases.ts` | Statement matrix: spec §4.1 forms plus PG18 syntax, each written in a valid order and fed to pg-topo reversed |
| `src/main.ts` | Runner: matrix, PoC and q35 fixtures, determinism probes (file renames, locale, unresolved references, leading comments, extraction probes, pg-delta's `analyzeForShadow`) |
| `src/topo.ts` | Loads both variants |
| `src/locale-child.ts` | Runs pg-topo under a given `LANG` (child process) |
| `src/pg.ts` | Embedded PG18 cluster (copied from the schema-ordering prototype) |

Reuses `../prototype-schema-ordering/src/analyze.ts` and `load.ts` (PoC ordering and catalog snapshot) and the fixtures of both earlier prototypes.

Findings: `.scratch/super-deploy/research/pg-topo-pg18.md`.
