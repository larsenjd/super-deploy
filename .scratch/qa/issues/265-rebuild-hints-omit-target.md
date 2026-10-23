# 265: "reset it with rebuild --to N" hints leave out --target, so the suggested command fails

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** disp
**Round:** 3

## What I did
Disposable shared-server target `scratch` at migration 2, with a draft deployed on it:

```sh
pnpm exec super-deploy deploy-draft --target scratch --with-seed   # YES
pnpm exec super-deploy status --target scratch
pnpm exec super-deploy deploy --target scratch
pnpm exec super-deploy mark --target scratch
```

And a Recovery draft of migration 2 with target `app` at migration 2:
```sh
pnpm exec super-deploy deploy-draft --target app
```

Then ran the suggested command as written: `pnpm exec super-deploy rebuild --to 2`.

## Expected
A suggestion I can paste, like the `disposable` one in the same messages already is: `flag it disposable again (disposable --target scratch --set yes)`.

## Actual
```
Deploy would refuse:
  the target holds draft add-notes (deployed by attempt #4 on top of 00002-add-orders, with seed data), not a finalized migration: reset it with rebuild --to 2
Error: Target scratch holds draft add-notes (...), not a finalized migration: reset it with rebuild --to 2
Error: The Recovery draft of migration 00002-pets runs on top of 00001-base, but target app is at 00002-pets: run rebuild --to 1 first
```
Running the hint:
```
$ pnpm exec super-deploy rebuild --to 2
Error: Missing required option --target. Run "super-deploy rebuild --help" for usage.
```
(exit 2)

## Notes
Same message text appears in `status`, `deploy`, `deploy-draft`, `mark` and in the attempt log. Also, `deploy-draft`'s refusal on a target holding a draft says `Target scratch failed the deploy pre-flight checks`, naming `deploy` rather than `deploy-draft`.
