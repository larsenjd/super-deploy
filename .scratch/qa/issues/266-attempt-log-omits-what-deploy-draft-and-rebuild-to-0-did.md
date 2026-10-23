# 266: Attempt log doesn't say which draft deploy-draft deployed, or that rebuild went to 0; a Recovery draft is called "draft pets"

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** disp
**Round:** 3

## What I did
On disposable shared-server targets:

```sh
# p2, no migrations yet, a first draft named "first"
pnpm exec super-deploy deploy-draft --target fresh          # YES
pnpm exec super-deploy rebuild --target fresh --to 0        # YES
pnpm exec super-deploy status --target fresh

# p3, a Recovery draft of migration 00002-pets, target at 00001-base
pnpm exec super-deploy deploy-draft --target app --with-seed   # YES
pnpm exec super-deploy status --target app
```

## Expected
README: "Each run's attempt records which way it set the flag, so `status`'s recent attempts show who made the target disposable and when." I expected the other guarded commands' attempts to be as specific: which draft (or Recovery draft) was deployed, with or without seed data, and that a rebuild went to no migrations, as `rebuild` to N shows `migrations 1-2` and `(migration 2 as Recovery 1)`.

## Actual
```
  #5 deploy-draft succeeded by jonathanl at 2026-10-21T23:07:30.974Z
  #3 rebuild succeeded by jonathanl at 2026-10-21T22:59:46.204Z
  #2 deploy-draft succeeded by jonathanl at 2026-10-21T22:59:44.537Z
```
No draft name, no seed data, and `rebuild ... --to 0` reads as if something were missing. Compare:
```
  #10 rebuild succeeded migrations 1-2 (migration 2 as Recovery 1) by jonathanl at ...
  #2 disposable set yes succeeded by jonathanl at ...
```

For the Recovery draft, `deploy-draft`'s own box and result say `the Recovery draft of migration 00002-pets`, but `status` then says:
```
  the target holds draft pets (deployed by attempt #9 on top of 00001-base, with seed data), not a finalized migration: reset it with rebuild --to 1
Drift: not checked (the target holds deployed draft pets; rebuild resets it)
```
"draft pets" reads like a new draft named after the existing migration `00002-pets`, not its Recovery.

## Notes
Only the current deployed draft is described (in "Deploy would refuse"); once it's rebuilt away, the log no longer says what was tried.
