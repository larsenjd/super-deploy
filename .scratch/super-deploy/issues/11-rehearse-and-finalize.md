# 11: Rehearse and finalize

Status: ready-for-agent
Type: task
Blocked by: 10, 08
Spec: ../spec.md

## What

`rehearse` and `finalize [--acknowledge-destructive]` (spec §5.1, §5.3, §4.5, §4.6, §6.2).

## Acceptance criteria

- [ ] Rehearsal replays every migration (newest variant), loads the draft's seed, runs pre → schema change → post, requires an empty diff vs desired schema.
- [ ] Finalize rehearses, refuses unacknowledged destructive changes, prints warnings and overrides, writes `meta.json`, snapshots the desired schema, freezes files, extends the chain.
- [ ] Finalizing a Recovery draft writes under `recoveries/` and proves structural identity with the original.
