# 231: A lock timeout while adoption reads the target doesn't help find the blocker, and `status` fails with a raw error

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** adopt
**Round:** 3

## What I did
Target `qa3_adopt_race` (managed schema `r`), not yet adopted. Config `lockTimeout: "20s"`.

```sh
# another session, as superuser, holds for 30 s:
#   begin; lock table r.t in access exclusive mode;
pnpm exec super-deploy init --adopt qa </dev/null &   # waits
pnpm exec super-deploy status --target qa              # 4 s later, to find out why
```

## Expected
The README's lock advice for deploy is "run `status` during the next wait
to see the session". The adoption's error says how to find what held the lock,
and `status` during the wait shows it, or at least fails with a message that
names the target and the lock.

## Actual
`status` during the wait:

```
Error: canceling statement due to lock timeout
```

It exits 1. There's no target name, no setting or value, and no hint that
something else holds a lock.

The adoption, once its 20 s run out:

```
Error: Target qa's lockTimeout (20s) ran out waiting for a lock while init --adopt read the target's managed schema (canceling statement due to lock timeout). Nothing was written, to the project or to target qa. Next: retry once whatever held the lock has finished, or raise lockTimeout for target qa in super-deploy.config.ts.
```

It gives no hint about how to find "whatever held the lock". When the
lock instead blocks adoption's later write phase, the error adds "To see which
session holds the lock next time, run status --target qa while super-deploy
waits, or select * from pg_stat_activity where pid = any(pg_blocking_pids(<its
server process>))". In that phase, `status` does name the holder
(`waiting for a lock held by server process 19595 (qa3_adopt_holder, ...)`).

## Notes
- Interrupting either wait with Ctrl+C works well: it exits 130 within 0.2 s, says
  `Target qa is unchanged`, and leaves no session behind.
- Guess: `status` hits the same table lock reading the catalog, and its
  lock-timeout error isn't wrapped like the others. Round 1 issue 41 may cover the `status` half.
