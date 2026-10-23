# 263: rebuild silently drops objects created in the managed schema while it waited for YES

**Status:** needs-triage
**Category:** enhancement
**Severity:** low
**Area:** disp
**Round:** 3

## What I did
Disposable shared-server target `app` (`managedSchema: "app"`), at migration 2. Started `rebuild` in a pseudo-terminal and, while it waited for YES, a colleague's session created a table with data in the managed schema:

```sh
pnpm exec super-deploy rebuild --target app --to 2
# at "Type YES ...", in another session as the deploy role:
#   create table app.important (x text); insert into app.important values ('precious row');
# then type YES
```

## Expected
README, `rebuild`: "The confirmation lists what in the managed schema no recorded migration created ... Objects in other schemas that depend on the managed schema ... if that list changes while it waits for `YES`, rebuild refuses without changing anything."

Since rebuild already re-checks the "Also drops, outside schema" list and refuses when it changes, I expected the same for the "Not from any recorded migration" list, so nothing is dropped that the confirmation didn't show.

## Actual
```
Rebuilt app with 2 migrations: 00001-base, 00002-pets (Recovery 1)
```
`select to_regclass('app.important')` → `null`: the table and its row are gone, never shown.

Doing the same with a new view outside the schema (`create view qa3rep.v2 as select name from app.people`) is refused:
```
Error: Target app changed while rebuild waited for YES (what it drops outside schema app): nothing changed; run rebuild again to see the new details
```

## Notes
The box does say "Drops everything in schema app", so this may be intended; but then the two lists are guarded inconsistently, and the README only promises the outside one. Low severity because the target is flagged disposable.
