# 20: Desired schema ordering

Status: ready-for-agent
Type: task
Blocked by: 05, 06
Spec: ../spec.md

## What

Load the desired schema into a throwaway database automatically and deterministically, with no file-naming convention (spec §3.2, ADR-0004). Production version of the proof of concept on branch `prototype/schema-ordering` (`25d5c18`); findings in `research/schema-ordering.md` and `research/pg-topo-pg18.md`.

## Acceptance criteria

- [ ] Statements (not files) ordered by kind priority and dependencies on `libpg-query@18`, sharing the rules engine's parser and walker.
- [ ] Ties broken only by object identity and statement-text hash; renaming files or reversing statement order never changes the order.
- [ ] Every reference shape bound at `CREATE` is modelled, including those pg-topo misses: `BEGIN ATOMIC` bodies, unqualified names in `LANGUAGE sql` bodies, argument defaults, trigger `WHEN`, composite type attributes, `%TYPE`, `::regclass`, implicit `_pkey`/`_seq` names. PL/pgSQL bodies are ignored for ordering.
- [ ] Calls wait for every overload of their function name.
- [ ] Circular foreign keys closed via `ALTER TABLE … ADD CONSTRAINT`.
- [ ] Unknown references and cycles reported with `file:line` before loading.
- [ ] Order-independence check: second load in a different valid order, catalogs (incl. bindings) compared; differences fail naming the objects.
- [ ] Fixture suite of 60–100 cases, including every case from both research spikes.
