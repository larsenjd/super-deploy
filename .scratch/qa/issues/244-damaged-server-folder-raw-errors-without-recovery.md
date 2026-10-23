# 244: Some damaged `.super-deploy/` server folders fail with raw pg_ctl/postgres output and no way forward

**Status:** needs-triage
**Category:** bug
**Severity:** low
**Area:** fail
**Round:** 3

## What I did
In a project made with `init`, after a few commands had created `.super-deploy/rehearsal` and `.super-deploy/dev`, with no command running:

```sh
# a) unreadable postmaster.pid
echo garbage > .super-deploy/rehearsal/postmaster.pid
pnpm exec super-deploy status --target qa

# b) data folder missing global/
mv .super-deploy/rehearsal/global /tmp/global.bak
pnpm exec super-deploy status --target qa      # same with .super-deploy/dev and --target dev

# c) data folder missing pg_wal/
mv .super-deploy/rehearsal/pg_wal /tmp/pg_wal.bak
pnpm exec super-deploy status --target qa
```

## Expected
README, "Connecting to dev": "If a crash or reboot leaves a server folder stale or damaged, commands that need it fail naming what looks wrong", and says what to do: delete `postmaster.pid`, or delete the folder (with what that loses for `dev`). The missing-`PG_VERSION` case does this well:

```
Error: .super-deploy/rehearsal is not a complete PostgreSQL data folder (it has no PG_VERSION): with no super-deploy command running, delete that folder; it holds only rehearsals' throwaway databases, so nothing is lost
```

## Actual
a)
```
Error: Embedded PostgreSQL failed to start in .super-deploy/rehearsal: pg_ctl: invalid data in PID file "/tmp/sd-qa3/fail/p2/.super-deploy/rehearsal/postmaster.pid"
```
b)
```
Error: Embedded PostgreSQL failed to start in .super-deploy/rehearsal: postgres: could not find the database system | Expected to find it in the directory "/tmp/sd-qa3/fail/p2/.super-deploy/rehearsal", | but could not open file "/tmp/sd-qa3/fail/p2/.super-deploy/rehearsal/global/pg_control": No such file or directory
```
c) the server's whole startup log on one line, joined with ` | `:
```
Error: Embedded PostgreSQL failed to start in .super-deploy/rehearsal: 2026-10-21 18:20:25.996 CDT [95443] LOG:  starting PostgreSQL 18.4 on x86_64-pc-linux-gnu, ... | ... FATAL:  required WAL directory "pg_wal" does not exist | ... LOG:  database system is shut down
```

None says to delete the file or folder, or what deleting it loses (for `dev`: what was added by hand).

## Notes
The other stale cases worked: a `postmaster.pid` naming a live non-server process got "no server answers there: if no super-deploy command is running, delete that file", and one naming a dead pid was cleaned up silently.
