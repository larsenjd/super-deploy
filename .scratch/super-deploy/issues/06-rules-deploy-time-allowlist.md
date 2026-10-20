# 06: Rules deploy time allowlist

Status: ready-for-agent
Type: task
Blocked by: 02
Spec: ../spec.md

## What

The parser-driven allowlist for deploy-time SQL (spec §4.2) using `libpg-query@18` + `@pgsql/types`, pinned. Test-first from `research/transactional-hazards.md`.

## Acceptance criteria

- [ ] Fixture suite: every hazard in the research file has a "refused" fixture; every allowed statement an "allowed" fixture.
- [ ] Per-file restrictions: pre-migration (DDL + DML), post-migration (DML only), seed (`INSERT` with column lists only), generated schema change.
- [ ] Function rules: `pg_catalog` only, minus the side-effect denylist; no `CALL`/`DO`.
- [ ] Column-order, identity, DML, temp-table, other-statement and reference rules.
- [ ] Each violation reports file, line, statement and the rule broken.
- [ ] Destructive-statement detection (§4.5) and rewrite/scan warnings (§4.6) exposed for `finalize`.
