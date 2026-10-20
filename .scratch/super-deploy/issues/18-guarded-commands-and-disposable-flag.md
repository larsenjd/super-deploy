# 18: Guarded commands and the disposable flag

**What to build:** A developer marks a target as disposable from inside its own database, through a guarded command that can't run by accident or in automation.

**Blocked by:** 04, 05

**Status:** resolved

**Spec:** `../spec.md`

- [ ] Guard sequence: refuse in CI or without a terminal on stdin and stdout; check preconditions; show the action plus the target's name, host, database and last recorded migration; require typing `YES` exactly; record a manual attempt under the OS username.
- [ ] No flag, environment variable or API option skips the guard.
- [ ] `disposable --target X --set yes|no` stores the flag in the history schema; new targets are not disposable.
- [ ] Guard refusals tested at the CLI process seam.
