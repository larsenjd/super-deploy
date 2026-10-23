# 248: Ctrl+C at a `YES` confirmation exits 1 as a failure, not 130

**Status:** needs-triage
**Category:** bug
**Severity:** low
**Area:** fail
**Round:** 3

## What I did
In a pseudo-terminal (120x40), with target `qa` on the shared server:

```sh
pnpm exec super-deploy disposable --target qa --set yes
```

Waited for `Type YES to mark target qa as disposable`, then pressed Ctrl+C.

## Expected
README, "Interrupting a command": "Ctrl+C (SIGINT) ... stops the running command. It cleans up first, then exits 130", and prints one line when the interruption arrives.

## Actual
```
■  Type YES to mark target qa as disposable
│
Error: disposable on target qa was not confirmed (cancelled): nothing changed
```

Exit status 1, the same as a real failure, and it is printed as an `Error:`. Ctrl+C anywhere else in the command (before or after the prompt) gives `Interrupted by SIGINT ...` and 130.

## Notes
The message itself is clear ("nothing changed"). The problem is only the exit code and the `Error:` label: a wrapper script can't tell "the user cancelled" from "the command failed". If cancelling at the prompt is meant to exit 1, the README's "Interrupting a command" should say so. Ctrl+C in the menu exits 0 with `Bye`, which seems fine.
