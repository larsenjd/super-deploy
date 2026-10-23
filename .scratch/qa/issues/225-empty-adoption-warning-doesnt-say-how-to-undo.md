# 225: The "Adopted 0 objects" warning doesn't say how to undo the adoption

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** adopt
**Round:** 3

## What I did
Target database `qa3_adopt_misc` has schemas `billing` and `"MyApp"` (one
table each), an empty schema `empty1`, and a table in `public`. I set
`managedSchema: "empty1"` by mistake:

```sh
pnpm exec super-deploy init --adopt qa </dev/null
```

And in a brand-new project with no changes to the config:

```sh
pnpm exec super-deploy init --adopt dev </dev/null
```

## Expected
When adoption has very likely gone wrong, it says what to do next. Adoption
has already recorded `00001-adopt` on the target, so the fix is the README's
"Starting an adoption over". The adopt-again refusals point to it.

## Actual
```
Adopted target qa as migration 00001-adopt in data-model/migrations/00001-adopt, recorded on it as marked (attempt #1)
warning: Adopted 0 objects from schema empty1; schema "MyApp" holds 1 table; schema billing holds 1 table; schema public holds 1 table: is managedSchema right?
```

```
Adopted target dev as migration 00001-adopt in data-model/migrations/00001-adopt, recorded on it as marked (attempt #1)
warning: Adopted 0 objects from schema public
```

It asks whether `managedSchema` is right, but not what to do if it isn't. A
user who just changes `managedSchema` and runs `init --adopt` again is
refused twice (project already has migrations, target already records one)
before reaching the README section.

## Notes
- Suggestion: end the warning with `to start over, see "Starting an adoption
  over" in README.md`, as the refusals do.
- `init --adopt dev` on a new project (picked in the menu, where `dev` is
  preselected under `init`) quietly makes an empty `00001-adopt`. Undoing that
  on `dev` means connecting as `deployer` with the README's keep-running
  snippet, or deleting `.super-deploy`. The README doesn't spell out either
  for this case.
