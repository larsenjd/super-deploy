# prototype-pg-delta (THROWAWAY)

Spike for `.scratch/super-deploy/issues/01-prototype-pg-delta-differ.md`. Not production code: no tests, no polish. Delete it when it has served its purpose.

Run from the repo root (Node 24, pnpm):

```
pnpm prototype:pg-delta
```

It starts a private PostgreSQL 18 cluster through `embedded-postgres` on a free port, in `prototype-pg-delta/.pgdata-wipe-me/`. It creates only databases named `prototype_pg_delta_wipe_me*`, runs every check, and prints a summary. It writes `output/` (the generated schema change for every scenario, plus `results.json`), then stops the cluster and deletes its data directory. A full run takes about 5 minutes. Set `PROTOTYPE_ONLY=q35` or `PROTOTYPE_ONLY=differ` to run one half.

- `src/differ.ts`: the thin wrapper that a `Differ` would become (extract, then plan, then the SQL).
- `src/catalog.ts`: a `pg_catalog` cross-check that does not depend on pg-delta.
- `src/scenarios.ts`: create/alter/drop states for every object type in spec §4.1.
- `src/differ-checks.ts`: column order, round trips and determinism.
- `src/loader.ts` and `fixtures/`: the Q35 desired-schema file-order experiments.

Findings: `.scratch/super-deploy/research/pg-delta-prototype.md`.
