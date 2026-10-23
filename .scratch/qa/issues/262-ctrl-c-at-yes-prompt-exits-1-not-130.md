# 262: Ctrl+C at a guarded command's YES prompt exits 1 as "cancelled", not 130 as the README says

**Status:** needs-triage
**Category:** docs
**Severity:** low
**Area:** disp
**Round:** 3

## What I did
In a pseudo-terminal, ran each guarded command, waited for `Type YES ...`, then pressed Ctrl+C (sent `\x03`):

```sh
pnpm exec super-deploy disposable --target scratch --set no
pnpm exec super-deploy rebuild --target scratch --to 1
```

For comparison, sent SIGTERM to the process group at the same prompt, and pressed Ctrl+C during a `rebuild` after YES (while it waited for a table lock).

## Expected
README, "Interrupting a command": "Ctrl+C (SIGINT), SIGTERM, or closing the terminal (SIGHUP) stops the running command. It cleans up first, then exits 130, 143 or 129 ... It prints one line when the interruption arrives."

## Actual
Ctrl+C at the prompt is treated as a cancelled answer:

```
■  Type YES to mark target scratch as not disposable
│
Error: disposable on target scratch was not confirmed (cancelled): nothing changed
```
exit status **1**, no `Interrupted by SIGINT` line.

SIGTERM at the same prompt gives `Interrupted by SIGTERM: cleaning up before exiting ...`, `Target scratch is unchanged: the interruption came before the rebuild started.`, exit 143. Ctrl+C after YES gives `The rebuild rolled back: target scratch is unchanged ...`, exit 130.

## Notes
Treating Ctrl+C at the prompt as "no" is reasonable and the message is clear; the README just doesn't say so, and a wrapper script checking for 130 would see 1. Either document that Ctrl+C (and Escape / Ctrl+D on an empty answer, which behave the same) at a question cancels with exit 1, or exit 130 there.
