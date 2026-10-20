# 01: Prototype pg delta differ

Status: resolved
Type: prototype
Spec: ../spec.md

## What

Prove whether `@supabase/pg-delta` can be the V1 differ (spec §2) and answer the pending file-order question (spec §3.2, `../pending-decisions.md`).

Throwaway prototype, not production code. Run against real PostgreSQL 18 (via `embedded-postgres`) on at least Linux, plus Windows if available.

## Acceptance criteria

- [x] Column order: a desired schema with a column added mid-table produces no reordering and no diff once the column exists at the end.
- [x] Object coverage: every supported object type in spec §4.1 round-trips (create, alter, drop) with an empty diff after applying the generated SQL.
- [x] Output is byte-identical across repeated runs on the same inputs.
- [x] Its directory loader (`schema apply --dir` or equivalent, possibly `@supabase/pg-topo`): does it reliably order desired-schema files by dependency on PG18, including cycles resolved via `ALTER TABLE … ADD CONSTRAINT`?
- [x] Note the API surface we would wrap behind our `Differ` interface, its exact version, footprint, and any Supabase-specific assumptions.
- [x] Write findings to `.scratch/super-deploy/research/pg-delta-prototype.md` with a recommendation: wrap pg-delta, or build our own differ.
- [x] **Do not decide Q35.** Present the file-order findings to the user and ask.

## Answer

**Verdict: wrap `@supabase/pg-delta`, pinned to exactly `1.0.0-alpha.59`, behind our `Differ` interface, on conditions.** Tested on PostgreSQL 18.4 (`embedded-postgres@18.4.0-beta.17`), Node 24.21, Linux x64. Windows was not tested because no Windows machine was available.

- Column order: pass. A column that already sits at the end gives no diff. A column added mid-table becomes a plain `ADD COLUMN`.
- Coverage: 82 of 90 create/alter/drop round trips are clean, and every action is transactional. Failures:
  - **virtual generated columns are silently emitted as `STORED`**, and pg-delta's own re-diff cannot see it;
  - `BETWEEN` in a check never converges (upstream #544);
  - PG18 NOT NULL constraint names are ignored;
  - comments on constraint-backed indexes are lost;
  - changing an in-use domain's base type is refused.
- Determinism: 91 of 91 outputs are byte-identical across fresh databases, shifted OIDs and reversed load order.
- Directory loader: it does **not** sort by dependency. It loads files in lexicographic order and retries the ones that fail. That converged on shuffled PG18 files, including an FK cycle closed by `ALTER TABLE`. pg-topo, the only static sorter, uses a PG17 parser and fails on PG18 syntax. **Q35 is not decided.** The evidence is laid out as options A–D for the user.
- Conditions:
  - do not install pg-topo;
  - add an engine-independent `pg_catalog` check to differ verification;
  - fix or refuse `VIRTUAL` columns until upstream fixes them;
  - track #544.

Findings: `.scratch/super-deploy/research/pg-delta-prototype.md`. Prototype: branch `prototype/pg-delta`, folder `prototype-pg-delta/`. Run it with `pnpm prototype:pg-delta`.
