# prototype-schema-ordering (THROWAWAY)

Spike for Q35 (`.scratch/super-deploy/pending-decisions.md`). It tests whether desired-schema statements can be put in dependency order automatically, with a result that never depends on file names. Not production code: no tests, no polish. Delete it when it has served its purpose.

Run from the repo root (Node 24, pnpm):

```
pnpm prototype:schema-ordering
```

It starts a private PostgreSQL 18 cluster through `embedded-postgres` in `prototype-schema-ordering/.pgdata-wipe-me/` and creates only databases named `prototype_schema_ordering_wipe_me*`. It runs every fixture, prints a summary and writes `output/console.txt` and `output/results.json`. Then it stops the cluster and deletes the data directory. A run takes about 10 s.

| File | What it does |
|---|---|
| `src/analyze.ts` | The ordering utility, on `libpg-query@18`. It splits files into statements and extracts what each provides and requires. It orders the statements by dependency, breaking ties by statement content only, and reports cycles. Lints flag ambiguous constructs. |
| `src/load.ts` | The loaders being compared: ours, path order and pg-delta's `loadSqlFiles`. Also a catalog snapshot (reuses `../prototype-pg-delta/src/catalog.ts`, adds `pg_depend` bindings and the index each foreign key uses). |
| `src/main.ts` | The runner. It includes the determinism guard: load the same statements in other valid orders and compare catalogs. |
| `src/scale.ts` | Timing on a large synthetic schema: `node src/scale.ts 1000`. |

Fixtures: `fixtures/*`, plus `../prototype-pg-delta/fixtures/q35-*`.

Findings are in `.scratch/super-deploy/research/schema-ordering.md`.
