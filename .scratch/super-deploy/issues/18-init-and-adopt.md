# 18: Init and adopt

Status: ready-for-agent
Type: task
Blocked by: 13, 16
Spec: ../spec.md

## What

`init` and `init --adopt <target>` (spec §9.7).

## Acceptance criteria

- [ ] `init` scaffolds from the template shipped in the library package.
- [ ] `--adopt` generates desired-schema files, creates `00001-adopt`, marks it on the target via the `mark` check.
- [ ] Refuses with a full list when the managed schema contains anything V1 refuses.
