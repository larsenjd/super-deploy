# 05: Interactive menu and CLI behaviour

**What to build:** Running `super-deploy` with no arguments in a terminal opens a menu grouped into Start, Author, Deploy, Recover and Disposable, which asks for each option and returns to the command just run. Every command also behaves predictably under Ctrl+C, SIGTERM and closed pipes.

**Blocked by:** 02

**Status:** resolved

**Spec:** `../spec.md`

- [ ] One set of command definitions drives both `util.parseArgs` and the `@clack/prompts` menu.
- [ ] Option kinds: target picked from config, migration from a searchable newest-first list, choice, name with a preview of the normalised result, flag. The menu never sets acknowledgement flags; commands ask yes/no (default no) when it matters, and refuse without the flag when there is no terminal.
- [ ] Failures print and return to the menu; cancelling a question runs nothing; `quit`, Escape or Ctrl+C leaves; no arguments without a terminal prints usage and exits 2.
- [ ] Results to stdout; warnings and progress to stderr; `--debug` adds stack traces and causes.
- [ ] Paths written are shown relative to the working directory; paths in errors relative to the project root.
- [ ] Interruption rolls back, releases the lock, drops throwaway databases and prints one notice; a second interrupt exits at once; exit codes 130, 141 and 143.
- [ ] Tested at the CLI process seam.
