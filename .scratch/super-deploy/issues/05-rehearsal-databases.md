# 05: Rehearsal databases

Status: ready-for-agent
Type: task
Blocked by: 03
Spec: ../spec.md

## What

Throwaway databases for drafts, rehearsals and drift checks (spec §5.3, §10.1, §10.2).

## Acceptance criteria

- [ ] Template adapter using `embedded-postgres` (PG18) providing rehearsal databases and the `dev` target, on Windows, macOS and Linux.
- [ ] Throwaway databases created with requested encoding, locale and collation provider; deploy's drift check can match a target's.
- [ ] Missing granted roles created as `NOLOGIN`, never dropped.
- [ ] Throwaway databases always dropped, including on interruption.
- [ ] Session settings pinned identically to deployments (spec §7.4).
