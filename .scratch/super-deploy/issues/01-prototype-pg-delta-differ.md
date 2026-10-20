# 01: Prototype pg delta differ

Status: ready-for-agent
Type: prototype
Spec: ../spec.md

## What

Prove whether `@supabase/pg-delta` can be the V1 differ (spec §2) and answer the pending file-order question (spec §3.2, `../pending-decisions.md`).

Throwaway prototype, not production code. Run against real PostgreSQL 18 (via `embedded-postgres`) on at least Linux, plus Windows if available.

## Acceptance criteria

- [ ] Column order: a desired schema with a column added mid-table produces no reordering and no diff once the column exists at the end.
- [ ] Object coverage: every supported object type in spec §4.1 round-trips (create, alter, drop) with an empty diff after applying the generated SQL.
- [ ] Output is byte-identical across repeated runs on the same inputs.
- [ ] Its directory loader (`schema apply --dir` or equivalent, possibly `@supabase/pg-topo`): does it reliably order desired-schema files by dependency on PG18, including cycles resolved via `ALTER TABLE … ADD CONSTRAINT`?
- [ ] Note the API surface we would wrap behind our `Differ` interface, its exact version, footprint, and any Supabase-specific assumptions.
- [ ] Write findings to `.scratch/super-deploy/research/pg-delta-prototype.md` with a recommendation: wrap pg-delta, or build our own differ.
- [ ] **Do not decide Q35.** Present the file-order findings to the user and ask.
