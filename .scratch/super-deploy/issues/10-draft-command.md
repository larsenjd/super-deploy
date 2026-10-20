# 10: Draft command

Status: ready-for-agent
Type: task
Blocked by: 01, 05, 06, 07, 09
Spec: ../spec.md

## What

`draft [--name]` (spec §5.2): load desired schema into D; replay migrations + seed + pre-migration script into R; diff R → D; write the schema change; report what scripts must cover.

The desired-schema file-order approach depends on the user's Q35 decision after issue 01.

## Acceptance criteria

- [ ] Creates or regenerates the draft; name normalised per §3.1, editable until finalize.
- [ ] Pre-migration script runs before the diff; renames done there produce no drop/add.
- [ ] Reports unresolved changes (e.g. dropped column with data).
- [ ] Generated schema change checked against deploy-time rules.
- [ ] Recovery drafts never regenerate the schema change.
