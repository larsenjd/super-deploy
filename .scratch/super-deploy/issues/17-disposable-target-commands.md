# 17: Disposable target commands

Status: ready-for-agent
Type: task
Blocked by: 13, 11
Spec: ../spec.md

## What

Guarded `disposable`, `deploy-draft [--with-seed]`, `rebuild --to N` (spec §8).

## Acceptance criteria

- [ ] Flag stored only in the target's history schema; new targets not disposable.
- [ ] `deploy-draft` and `rebuild` refuse on non-disposable targets.
- [ ] Seed data loaded only by `deploy-draft --with-seed`; never by `rebuild`.
