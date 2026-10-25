# 02: Multi-file diffs that `git apply` accepts

**What to build:** Groundwork for storing snapshots as diffs (spec: `.scratch/snapshot-diffs/spec.md`, "Format" and the unit seam in "Testing Decisions"). The unified-diff module, which today writes the hand-edit report and reverses it for unfinalize, can also write one diff covering a set of files in the format `git diff` writes, and apply such a diff strictly to a set of files. Nothing uses it yet; database-free unit tests prove it.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Writing a diff between two sets of files (path and text) gives `--- a/<path>` / `+++ b/<path>` headers, `/dev/null` on one side for an added or deleted file, three lines of context, files in path order, `\ No newline at end of file` where needed, and an empty diff when the sets are equal.
- [ ] Line endings are normalised to LF before diffing, so CRLF alone is never a change.
- [ ] Applying a diff to the "before" set gives exactly the "after" set. Every context and removed line must match, with no fuzz and no offset search.
- [ ] A hunk that doesn't match throws `SnapshotDiffDoesNotApplyError` (`snapshot-diff-does-not-apply`), naming the file whose hunk failed, with room for the caller to name the migration. It is exported from the public API.
- [ ] Unit tests, importing the module directly as the SQL-analysis tests import theirs, cover: no trailing newline on either side, CRLF input, empty files, a file deleted and another added at the same path, many hunks in one file, adding to and deleting from nested folders, round trips of each, and the error on mismatched text.
- [ ] A unit test checks that `git apply` accepts a written diff and produces the same files (skipped only if `git` isn't installed).
- [ ] The existing hand-edit report and its reversal behave as before.
