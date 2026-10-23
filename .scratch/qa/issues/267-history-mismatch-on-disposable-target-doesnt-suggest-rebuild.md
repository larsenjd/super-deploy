# 267: A disposable target whose recorded history no longer matches isn't told it can simply be rebuilt

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** disp
**Round:** 3

## What I did
In a project with four migrations, `dev` flagged disposable and deployed to 4. Then changed migration 4 (the everyday "I want to tweak what I just finalized" on dev):

```sh
pnpm exec super-deploy deploy --target dev            # Deployed ... 00003-add-notes, 00004-email-idx
pnpm exec super-deploy unfinalize </dev/null           # Moved migration 00004-email-idx back into draft
# change the index in the desired schema to (lower(email))
pnpm exec super-deploy draft --name "email idx"
pnpm exec super-deploy finalize
pnpm exec super-deploy status --target dev
```

## Expected
`dev` is flagged disposable, and `rebuild --target dev --to 4` fixes this in one step (I tried it: it works, `Drift: none` after). I expected `status`/`deploy` on a disposable target to offer that, the way they offer `rebuild` for a deployed draft.

## Actual
```
Target dev (disposable): 4 migrations recorded, 0 pending
Deploy would refuse:
  the target records migration 00004-email-idx with content hash 7403..., but the repo's is 2510...: restore 00004-email-idx (and index.json) from version control (a migration a target has recorded must never change, so put new changes in a new migration)
Drift: not checked (the recorded history doesn't match the project's migrations)
```
Only "restore from version control" is offered, which throws away the change I wanted to keep.

## Notes
README "Changing your mind" warns not to unfinalize a recorded migration "even only `dev`", and offers restoring or re-finalizing; it doesn't mention `rebuild` for a disposable target either. Rebuild's confirmation for this case also omits the "Not from any recorded migration" list (the old index differs from the new migration 4), presumably because no replica of the recorded history can be built.
