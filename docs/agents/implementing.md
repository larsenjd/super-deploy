# Implementing a ticket

How an implementer works here, usually alongside others, each in a git worktree of its own. The orchestrator's task names your worktree, your branch and the integration branch it merges into.

## Before the first edit

1. Work only in your worktree, on your branch. Check the branch starts from the integration branch's tip: `git merge-base --is-ancestor <integration> HEAD`. If it doesn't and you have committed nothing, `git reset --hard <integration>`.
2. Run `pnpm install`. It readies a fresh worktree: dependencies, this worktree's pre-commit hook, and a built `dist/`.
3. Orient: the ticket (`.scratch/<feature>/issues/NN-*.md`), the spec sections it cites, `GLOSSARY.md`, the ADRs on its area, then `docs/agents/code-map.md` for the files to read.

## While working

- Build with the `tdd` skill (`mattpocock-skills:tdd`), at the seams in `docs/agents/testing.md`. Run the test file at hand; save the full suite for the end.
- Write to `CODING_STANDARDS.md`: reviewers hold the code to it.
- Put knowledge the next implementer needs into the repo: the header comment of the file it concerns, or the matching doc in `docs/agents/` when it spans files. Reports and notes outside the repo go stale unseen.
- The ticket's `Status:` line is the orchestrator's to change.
- End commit messages with the `Co-Authored-By` line the task gives.

## Embedded PostgreSQL next to other implementers

Other worktrees run their suites on this machine at the same time.

- Every server you start, in a test, a script or a hand-run CLI, gets a free port and a data dir of its own. Tests get both from `startTestServer`. The embedded adapter always picks a free port; keep its `dataDir` inside your worktree or a new temp folder.
- Stop what you started (`server.stop()` in tests, `project.close()` in scripts), and find any leftover by its data dir. Every other postgres process belongs to someone else's run.

## The shell

The Bash tool runs zsh, which expands unquoted globs and words starting with `=` itself. Quote them: `grep -rn --include='*.ts' word src`, `echo '===='`. Unquoted, they fail with "no matches found" or "== not found".

## Before reporting

1. Commit everything.
2. `git merge <integration>` into your branch, so merging back is a fast-forward; resolve any conflicts.
3. Run the full suite once, `pnpm test` at the root, then `pnpm precommit`.
4. Report: branch, final commit, what was built, the test commands and their results, and anything deferred.
