# 246: `status` hitting `lockTimeout` in its drift check fails with only `canceling statement due to lock timeout`

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** fail
**Round:** 3

## What I did
Target `qa` on the shared server, managed schema `app`, no pending migrations, `Drift: none`:

```ts
qa: { adapter: postgresTarget({ env: "QA_DATABASE_URL" }), lockTimeout: "20s" },
```

From another session (as `postgres`), keep this transaction open for 100 s:

```sql
begin;
lock table app.orders in access exclusive mode;
```

Meanwhile:

```sh
pnpm exec super-deploy status --target qa; echo "exit=$?"
```

## Expected
README, "Targets": `lockTimeout` applies "to super-deploy's reads of the target's schema (its drift check ...)". README, "When a deploy fails": when a lock timeout runs out while super-deploy reads the target, "the error says so, names the target (and, for a timeout, the setting and its value), and says it is unchanged". `deploy` does this in the same situation:

```
Error: Target qa's lockTimeout (20s) ran out waiting for a lock (canceling statement due to lock timeout). Nothing changed on target qa. Next: retry once whatever held the lock has finished, or raise lockTimeout for target qa in super-deploy.config.ts. To see which session holds the lock next time, run status --target qa while super-deploy waits, or select * from pg_stat_activity where pid = any(pg_blocking_pids(<its server process>)).
```

For `status` I expected the same kind of message, or better, the rest of the report (migrations recorded, pending, recent attempts) with `Drift: not checked (...)`, as it does when another command holds the target.

## Actual
After 66 s (about 45 s building the replica, then the 20 s `lockTimeout`), nothing on stdout, and on stderr only:

```
Error: canceling statement due to lock timeout
exit=1
```

No target, no setting or value, no hint about who holds the lock. Nothing of the report it could already show is printed. `--debug` shows it comes from `driftBetween` → `catalogFacts`.

## Notes
Reproduced twice. A user running `status` to find out why deploys are stuck gets the least information exactly when a lock is the problem.
