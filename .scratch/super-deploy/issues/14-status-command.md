# 14: Status command

Status: ready-for-agent
Type: task
Blocked by: 13
Spec: ../spec.md

## What

`status --target` (spec §7.8).

## Acceptance criteria

- [ ] Reports pending migrations, drift, disposable flag, recent attempts, missing roles/external schemas, privilege warnings.
- [ ] Settles `unknown` attempts.
- [ ] Exits 1 on drift or refusal.
