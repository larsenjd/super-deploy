# 15: Recovery command

Status: ready-for-agent
Type: task
Blocked by: 11, 13
Spec: ../spec.md

## What

`recovery --migration N` (spec §6.3).

## Acceptance criteria

- [ ] Creates a Recovery draft carrying N's schema change unchanged; refuses if any draft exists.
- [ ] Deploy uses the newest Recovery for targets that haven't recorded N, and records the variant.
