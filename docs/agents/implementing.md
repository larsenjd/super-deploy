# Implementing a ticket

How an implementer works here, usually alongside others, each in a git worktree of its own. The orchestrator's task names your worktree, your branch and the integration branch it merges into.

## Before the first edit

1. Work only in your worktree, on your branch. Check the branch starts from the integration branch's tip: `git merge-base --is-ancestor <integration> HEAD`. If it doesn't and you have committed nothing, `git reset --hard <integration>`.
2. Run `pnpm install`. It readies a fresh worktree: dependencies, this worktree's pre-commit hook, and a built `dist/`.
3. Orient: the ticket (`.scratch/<feature>/issues/NN-*.md`), the spec sections it cites, `GLOSSARY.md`, the ADRs on its area, then `docs/agents/code-map.md` for the files to read. Read each one in a call of its own: a spec and the code map run to about 25 KB each, and two together are too large to show.

## While working

- Build with the `tdd` skill (`mattpocock-skills:tdd`), at the seams in `docs/agents/testing.md`. Run the test file at hand; save the full suite for the end.
- Write to `CODING_STANDARDS.md`: reviewers hold the code to it.
- Before committing, fix formatting with `pnpm exec biome check --write <paths>` (from the root or a package) and check copies with `pnpm --filter super-deploy duplicates`: the hook only reports them.
- Put knowledge the next implementer needs into the repo: the header comment of the file it concerns, or the matching doc in `docs/agents/` when it spans files. Reports and notes outside the repo go stale unseen.
- The ticket's `Status:` line is the orchestrator's to change.
- End commit messages with the `Co-Authored-By` line the task gives.

## Embedded PostgreSQL next to other implementers

Other worktrees run their suites on this machine at the same time.

- Every server you start, in a test, a script or a hand-run CLI, gets a free port and a data dir of its own. Tests get both from `startTestServer`. The embedded adapter picks a free port unless its config sets `port` (the template's `dev` server does): a test or script that sets one picks a port that is free when it runs. Keep its `dataDir` inside your worktree or a new temp folder.
- Stop what you started (`server.stop()` in tests, `project.close()` in scripts), and find any leftover by its data dir. A server runs in a session of its own, so it outlives a command or test killed outright: stop a leftover with `pg_ctl stop -D <dataDir>` (or `stopServerOn(dataDir)` in a test). Every other postgres process belongs to someone else's run.

## The shell

The Bash tool runs zsh, which expands unquoted globs and words starting with `=` itself. Quote them: `grep -rn --include='*.ts' word src`, `echo '===='`. Unquoted, they fail with "no matches found" or "== not found".

The working directory carries over from one Bash call to the next. Use absolute paths, or `pnpm -C packages/super-deploy exec ...` from the root, rather than a relative `cd`.

## Before reporting

1. Commit everything. Every commit, merge commits included, goes through the pre-commit hook. Run each `git commit` in a Bash call of its own, in the foreground with `timeout: 600000`, its output to a log file rather than a pipe. The hook takes seconds and stops itself after five minutes, so wait for it: a turn that ends while a commit is still running leaves the work uncommitted.
2. `git merge <integration>` into your branch, so merging back is a fast-forward; resolve any conflicts.
3. Run the full suite once, `pnpm test` at the root, then `pnpm precommit`, each in the foreground to completion. Report only once both have finished.
4. Report: branch, final commit, what was built, the test commands and their results, and anything deferred.

## Merging into the integration branch

For whoever merges a finished branch, usually a merger the orchestrator starts.

- **A fast-forward** to the commit the implementer reported, with a passing `pnpm test` and `pnpm precommit`, needs no rerun: that tree was tested.
- **A real merge**, conflicts or not, makes a tree nobody has tested. Run `pnpm test`, then `pnpm precommit`, as in "Before reporting".
- **Resolving the ticket**: set its `Status:` line, and tick only the boxes the implementer's report says are done. List any box left unticked in your report, with the reason.
