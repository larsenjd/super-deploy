# 240: Closing the terminal during a command run with `pnpm exec` exits at once, leaving the embedded server running and the attempt unsettled

**Status:** needs-triage
**Category:** bug
**Severity:** medium
**Area:** fail
**Round:** 3

## What I did
A project made with `init` (generated config, `dev` plus a `qa` target on the shared server via `postgresTarget({ env: "SIG_DATABASE_URL" })`), with a pending migration whose post-migration script takes ~12 s.

In a pseudo-terminal running an interactive shell (`zsh -f -i`, driven from Python's `pty`), I typed:

```sh
pnpm exec super-deploy rehearse 2>/tmp/err.log
```

and closed the terminal (closed the pty master) about 8 s in, while the rehearsal was running. Then, from another shell:

```sh
ps -eo pid,args | grep 'bin/postgres -D /tmp/.../p2/.super-deploy'
cat /tmp/err.log
```

Same with `pnpm exec super-deploy deploy --target qa 2>/tmp/err.log`, closing the terminal while the deployment's post-migration script ran on `qa`, then `pnpm exec super-deploy status --target qa`.

To see which signals the command gets, I ran a tiny Node script that logs signals the same way (`pnpm exec node siglog.mjs`) and closed the terminal.

## Expected
README, "Interrupting a command": closing the terminal (SIGHUP) cleans up (throwaway databases dropped, embedded servers stopped, deployment rolled back and recorded as abandoned), and "Nor does a second SIGHUP [count]: no one is left at the terminal to insist."

## Actual
The command prints the first notice, then exits without cleaning up:

```
Interrupted by SIGHUP: cleaning up before exiting (interrupt again to exit at once)
```

and the rehearsal server is still running afterwards:

```
50140  1  50140 .../native/bin/postgres -D /tmp/sd-qa3/fail/p2/.super-deploy/rehearsal -p ...
```

For `deploy`, the attempt is not recorded as interrupted; the next `status` settles it as:

```
#8 deploy abandoned migration 3 by jonathanl at ...: The command ended without recording an outcome; settled as abandoned: none of its migrations are recorded
```

The signal logger shows what the command receives under `pnpm exec` in an interactive shell when the terminal closes:

```
2967ms SIGHUP
2967ms SIGHUP
2967ms SIGHUP
2967ms SIGTERM
2967ms SIGCONT
```

Running the binary directly (`./node_modules/.bin/super-deploy rehearse`) the same way cleans up correctly (no server left). With `pnpm exec` as the session leader (no shell), closing the terminal also cleaned up correctly.

## Notes
Guess: the SIGTERM pnpm forwards right after the SIGHUPs is a different signal, so it counts as "interrupting again" and the command exits at once. The README's double-signal rule only exempts the same signal and repeated SIGHUP. The next command that uses the server does take it over and stop it (`status` did here), so the damage is a leftover server and a less useful attempt record.
