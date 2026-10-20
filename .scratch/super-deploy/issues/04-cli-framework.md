# 04: Cli framework

Status: ready-for-agent
Type: task
Blocked by: 02
Spec: ../spec.md

## What

One set of command definitions driving both `util.parseArgs` flags and the `@clack/prompts` menu (spec §9.2–§9.6). Commands can be stubs; this issue is the shell.

## Acceptance criteria

- [ ] Direct and interactive modes behave as spec §9.2, including no-args-no-terminal → usage, exit 2.
- [ ] Option kinds per §9.3, including name normalisation (§3.1) with preview.
- [ ] Usage errors for unknown/repeated/missing/invalid options; nothing runs.
- [ ] `--help`, `<command> --help`, `--debug`; stdout/stderr split; one-line `Error:` messages.
- [ ] Guarded-command sequence (§9.4) as a reusable wrapper: refuses in CI or without a TTY, shows the action, requires `YES`.
- [ ] Interruption handling and exit codes per §9.5 (cleanup hooks the later commands register into).
- [ ] Every command also exported as a function with options and callbacks; typed errors.
