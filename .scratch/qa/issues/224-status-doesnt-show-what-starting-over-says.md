# 224: "Starting an adoption over" tells you to check for things `status` never prints

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** adopt
**Round:** 3

## What I did
I adopted a target, then followed the README's "Starting an adoption over",
which says:

> can be started over, but only while the target records nothing but the
> adoption: `status --target <target>` shows `1 migration recorded`,
> `00001-adopt`, marked.

```sh
pnpm exec super-deploy init --adopt qa
pnpm exec super-deploy status --target qa
```

## Expected
`status` shows `1 migration recorded`, the name `00001-adopt`, and that it was
marked, so I can check all three before dropping the history schema.

## Actual
```
Target qa: 1 migration recorded, 0 pending
Drift: none
Recent attempts:
  #1 init --adopt succeeded migration 1 by jonathanl at 2026-10-21T22:46:43.421Z
```

Neither `00001-adopt` nor "marked" appears. Nothing in the output names the
recorded migration, or says it was marked rather than run. "#1 init --adopt
succeeded migration 1" is the closest.

## Notes
This check guards a destructive step (`drop schema deployment_history cascade`),
so it matters that the user can actually make it. Either `status` should name
the recorded migrations (or at least the newest, and how it was recorded),
or the README should describe what `status` really prints: "1 migration
recorded, 0 pending", and an attempt `init --adopt succeeded migration 1`.
