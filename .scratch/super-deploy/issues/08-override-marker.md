# 08: Override marker

Status: ready-for-agent
Type: task
Blocked by: 07
Spec: ../spec.md

## What

`-- OVERRIDE DANGEROUS COMMAND: <reason>` (spec §4.4).

## Acceptance criteria

- [ ] Exact-form match on the line before the statement; reason required.
- [ ] Overrides only risk rules; transaction-breaking rules never overridable.
- [ ] Recorded by object identity so regenerated schema changes honour it.
- [ ] Surfaced in `meta.json`, `finalize` output and `validate`.
