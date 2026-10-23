# 211: While a deploy waits for a lock, `status` shows the blocker as "<insufficient privilege>" for a non-superuser deploy role

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** newproj
**Round:** 3

## What I did
Target `qa` deployed as `qa3_newproj_deploy`, a non-superuser set up as "Permissions" asks. Another session (the superuser `postgres`, `application_name` `qa3-newproj-lockholder`) holds `ACCESS SHARE` on `orders` in an open transaction. Then:

```sh
pnpm exec super-deploy deploy --target qa &      # waits for the lock
pnpm exec super-deploy status --target qa         # 1.5 s later
```

## Expected
README, "Targets": "A deployment that waits for a lock another session holds ... shows in `status` as `waiting for a lock held by server process N`, with that session's application name, user, state and statement."

## Actual
```
Locked by attempt #5 (deploy by jonathanl, ..., statement started ...: alter table orders drop column total), waiting for a lock held by server process 4171946 (qa3-newproj-lockholder, postgres: <insufficient privilege>)
```

State and statement are PostgreSQL's `<insufficient privilege>` placeholder, because a role can't see other roles' `pg_stat_activity` rows without `pg_read_all_stats`. The format `postgres: <insufficient privilege>` also reads as if the user `postgres` lacked a privilege.

## Notes
- Either say in "Permissions"/"Targets" that seeing other sessions' state and statement needs `grant pg_read_all_stats to <deploy role>`, or have `status` print something like "state and statement hidden: the deploy role needs pg_read_all_stats".
- The lock-timeout error itself was clear and correct.
