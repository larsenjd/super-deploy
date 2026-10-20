# 16: Mark command

Status: ready-for-agent
Type: task
Blocked by: 13
Spec: ../spec.md

## What

Guarded `mark --target --migration` (spec §7.7).

## Acceptance criteria

- [ ] Only the next pending migration.
- [ ] Locale-matched replica of 00001..N; empty diff required (column order and ownership ignored).
- [ ] Writes only to the target's history schema; manual attempt under the OS username.
