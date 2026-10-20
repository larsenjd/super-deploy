# Pending decisions

None open. Resolved decisions are kept below for history.

Decisions deliberately deferred until evidence arrives. Ask the user again before making the final call.

## Ordering desired-schema files (Q35) — RESOLVED

**Decision (user, after three research spikes):** option A′, our own automatic ordering utility on `libpg-query@18` with an order-independence check and static refusals. See spec §3.2 and ADR-0004.

Original question:

Test in the differ prototype whether `@supabase/pg-delta`'s directory loader (`schema apply --dir`, possibly via `@supabase/pg-topo`) reliably orders desired-schema files by dependency on PostgreSQL 18.

- If it does: files need no ordering convention.
- If not: apply files in path order (raw code-point sort of `/`-separated relative paths; paths differing only by case refused), with numbered prefixes by convention. Retry-until-no-progress loading goes to REFINEMENTS.

**Do not finalize without asking the user.**
