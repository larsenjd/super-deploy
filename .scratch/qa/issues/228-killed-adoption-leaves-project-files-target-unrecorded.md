# 228: An adoption killed outright leaves 00001-adopt in the project but nothing recorded on the target

**Status:** needs-triage
**Category:** bug
**Severity:** low
**Area:** adopt
**Round:** 3

## What I did
Target `qa3_adopt_race`, managed schema `r` (as in issue 227), with no history
schema. Config `lockTimeout: "60s"`.

1. In another session, as a superuser, I held a lock:
   `begin; lock table r.t in access exclusive mode;` (and kept it open for 30 s).
2. In a terminal I ran `pnpm exec super-deploy init --adopt qa` and answered the override reason.
   Adoption then waits for the lock. By now it has already written
   `data-model/migrations/00001-adopt/` and the desired schema
   (`find data-model -type f` lists 8 files).
3. I killed it outright: `kill -KILL -- -<pgid>`, standing in for a crash or a closed laptop.
4. After the lock was released:

```sh
pnpm exec super-deploy status --target qa
pnpm exec super-deploy init --adopt qa </dev/null
```

## Expected
Either the project files appear only once the target has recorded the
adoption, or the docs say how to recover from this state.

## Actual
The project keeps the adoption's files, but the target records nothing:

```
Target qa: 0 migrations recorded, 1 pending
Drift (the target differs from its recorded migrations):
  function r.f(): only on the target ...
  table r.t: only on the target ...
Pending:
  00001-adopt
Recent attempts:
  #3 init --adopt abandoned migration 1 by jonathanl at ...: The command ended without recording an outcome; settled as abandoned: none of its migrations are recorded
Error: Target qa has drifted from its recorded migrations: ... If its changes are those of the next pending migration applied by hand, mark --target qa records that migration as deployed (see the README, "Drift")
```

Adopting again is refused and points to "Starting an adoption over":

```
Error: Cannot adopt target qa: the project already has migrations in data-model/migrations (to start the adoption over, see "Starting an adoption over" in README.md); the desired schema already has ...
```

That section says it applies "only while ... `status --target <target>` shows
`1 migration recorded`", which isn't the case here. The two documented paths
disagree, and neither describes this state.

## Notes
- Workaround that works: `mark --target qa` (type YES) records `00001-adopt` as marked.
  Its confirmation says the target matches a replica of it. Deleting the files
  and the history schema, then adopting again, also works.
- Ctrl+C at the same moment is fine: the files are removed and the attempt is
  recorded as abandoned. Only kill -9 or a crash leaves this state.
- `deploy --target qa` refuses because of drift, so nobody can accidentally run the
  adoption's `CREATE` statements against the live schema. Good.
