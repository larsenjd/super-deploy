# 205: `unfinalize` in a terminal moves a deployed migration without asking: its "don't change it" warning arrives with the result

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** newproj
**Round:** 3

## What I did
Project whose newest migration, 00010-delivered, is deployed to `dev`. No draft, desired schema matching the snapshot. In a real terminal (pty):

```sh
pnpm exec super-deploy unfinalize
pnpm exec super-deploy status --target dev
```

## Expected
The README says `unfinalize` "warns about this before it moves a migration". In a terminal I expected the warning to come with a question I could say No to, as `discard-draft` and `restore-schema` ask, since moving a deployed migration breaks every target that recorded it.

## Actual
It prints the warning and moves the migration in the same instant, with no question:

```
warning: If migration 00010-delivered was deployed anywhere, don't change it: finalize it again unchanged, with the same super-deploy and rehearsal server versions, to put it back, then make the change in a new migration (or in a Recovery, if it failed on a target)
Moved migration 00010-delivered back into draft delivered in data-model/draft
```

and then `status --target dev` exits 1 with "Deploy would refuse: the target records migration 00010-delivered, which the repo doesn't have ...". It only asks when it would also overwrite a draft or changed desired-schema files; then the warning is part of the question.

## Notes
- This matches the letter of the README ("in its question when it asks one"), so it's an enhancement: ask in a terminal every time (the risk is the move itself, not only the overwrite). Without a terminal, the current warn-and-proceed is reasonable.
- Recovery worked as documented: `finalize` unchanged reproduced the migration byte for byte, including a migration with `HAND-EDITED.md`.
