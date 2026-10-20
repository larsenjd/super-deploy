# 12: Draft housekeeping commands

Status: ready-for-agent
Type: task
Blocked by: 11
Spec: ../spec.md

## What

`unfinalize`, `restore-schema`, `discard-draft` with `--acknowledge-overwrite` (spec §5.5).

## Acceptance criteria

- [ ] Each behaves per §5.5; acknowledgement prompt in a terminal, flag required without one.
- [ ] `unfinalize` handles both migrations and Recoveries and restores read-write files.
