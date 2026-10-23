# 213: The menu's draft name prompt offers "leave empty to skip" when there is no draft, then fails asking for `--name`

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** newproj
**Round:** 3

## What I did
In a project with no draft and an undrafted desired-schema change, in a terminal:

```sh
pnpm exec super-deploy          # menu; "draft" is preselected
# Enter, then Enter again at the name prompt
```

## Expected
With no draft yet, the prompt asks for the new draft's name and doesn't offer to skip (or re-asks on empty input), in the menu's own terms.

## Actual
```
◆  Name for a new draft, or a new name for the existing draft (spaces become hyphens)
│  █
└  (leave empty to skip)
◇  Name for a new draft, or a new name for the existing draft (spaces become hyphens)
│  (none)
Error: There is no draft yet, so a name is required to create one (--name)
│
◆  What do you want to do?
```

The prompt is the `--help` text for `--name`, covering both cases, and offers to skip although a name is required; the error then refers to a command-line flag the menu user never typed.

## Notes
With an existing draft, the same prompt and empty answer correctly keep its name. Typing a name worked well: the live preview (`→ add-region`) of the normalised name is a nice touch.
