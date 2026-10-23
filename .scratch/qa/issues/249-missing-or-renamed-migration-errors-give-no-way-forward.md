# 249: A deleted or renamed finalized migration is refused without saying how to restore it

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** fail
**Round:** 3

## What I did
In a project with 7 finalized migrations, committed to Git:

```sh
chmod -R u+w data-model/migrations/00007-add-labels
rm -rf data-model/migrations/00007-add-labels
pnpm exec super-deploy validate
pnpm exec super-deploy status --target qa
git checkout -q HEAD -- data-model/migrations

mv data-model/migrations/00006-add-tags data-model/migrations/00006-add-tagz
pnpm exec super-deploy validate
```

## Expected
The same help an edited migration gets, which works well:

```
error: data-model/migrations/00002-add-orders was changed after it was finalized (...): restore it from Git (`git checkout HEAD -- data-model/migrations/00002-add-orders`, and delete any file added to it), then run validate, which makes it read-only again. ...
```

## Actual
```
error: data-model/migrations/00007-add-labels is missing
Error: Validation failed with 1 error, listed above
```
```
Error: The finalized migrations failed validation: data-model/migrations/00007-add-labels is missing
```
```
error: Migration 6 was renamed from 00006-add-tags to 00006-add-tagz; finalized migrations never change
Error: Validation failed with 1 error, listed above
```

Neither says what to do: restore the folder from Git, or rename it back. The README's "Changing your mind" covers only an edited migration, a file added, or a changed snapshot. A deleted or renamed one isn't mentioned, though "The files of a draft and a migration" says the hook blocks "an edited or renamed finalized migration".

## Notes
Restoring with `git checkout HEAD -- data-model/migrations` and running `validate` fixed both (`Made 14 finalized files read-only again`).
