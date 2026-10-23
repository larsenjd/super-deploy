# 214: Two branches that each finalize the next migration conflict on merge, and neither the README nor `validate` says how to resolve it

**Status:** needs-triage
**Category:** docs
**Severity:** medium
**Area:** newproj
**Round:** 3

## What I did
Project at migration 00018 on `master`. Two feature branches each add a table and finalize, as two developers would:

```sh
git checkout -b feature-a
echo "create table a_things (id bigint primary key);" > data-model/desired-schema/a_things.sql
pnpm exec super-deploy draft --name "a things" && pnpm exec super-deploy finalize && git add -A && git commit -m a
git checkout master && git checkout -b feature-b
echo "create table b_things (id bigint primary key);" > data-model/desired-schema/b_things.sql
pnpm exec super-deploy draft --name "b things" && pnpm exec super-deploy finalize && git add -A && git commit -m b
git checkout master && git merge feature-a && git merge feature-b
pnpm exec super-deploy validate
git checkout --ours data-model/migrations/index.json     # the obvious first attempt
pnpm exec super-deploy validate
```

## Expected
The README (e.g. in "The files of a draft and a migration" or "Changing your mind") says what to do when another branch finalized the same migration number first, and `validate`'s error points there.

## Actual
```
CONFLICT (content): Merge conflict in data-model/migrations/index.json
```

`validate` on the conflicted file:

```
error: data-model/migrations/index.json is not valid JSON (Expected property name or '}' in JSON at position 4371 (line 101 column 1))
warning: The desired schema has no migration or draft yet; run draft
Error: Validation failed with 1 error, listed above
```

(the warning is wrong: there are 19 migrations). After keeping one side's `index.json`:

```
error: data-model/migrations/00019-b-things reuses migration number 19
Error: Validation failed with 1 error, listed above
```

with no next step. `status` and `deploy` refuse the same way.

## Notes
- What worked (worked out from the `unfinalize` docs): abort the merge; on `feature-b`, `unfinalize` (00019-b-things wasn't deployed anywhere), commit, `git merge master`, `draft` (keeps the name), `finalize` → `00020-b-things`. Clean result, `validate` passes.
- Worth a short "When another branch finalized first" paragraph, including the case where the other branch's migration was already deployed to `dev` (then `dev` needs `rebuild`), and `validate`'s "reuses migration number" error could point to it.
- Also worth saying in CI terms: `validate --strict` on the merged result is what catches this.
