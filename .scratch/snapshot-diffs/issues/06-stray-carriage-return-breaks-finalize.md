# 06: A stray carriage return before a line ending breaks finalize

**What to build:** A developer whose desired-schema file contains a carriage return just before a Windows line ending (`\r\r\n`) can finalize, and the snapshot rebuilt from the diff is that file with line endings normalised exactly as the rest of the snapshot is. Today `finalize` stops with the "Bug in super-deploy" error, because the diff writer normalises line endings once and the strict applier normalises the diff text again, so the two disagree. Found while fixing the code review; see `.scratch/snapshot-diffs/spec.md` ("Format": "text with line endings normalised to LF") and ADR-0008.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] Line endings are normalised once, the same way on both sides: what the writer diffs is exactly what the applier rebuilds, so applying a written diff to its "before" files always gives its "after" files, whatever carriage returns the files hold.
- [ ] Unit tests at the diff module's seam: a round trip with `\r\r\n`, a lone `\r` inside a line and at the end of a file, and a mix of LF and CRLF lines, each also accepted by `git apply`.
- [ ] API test: finalize a desired-schema file containing `\r\r\n`, then `unfinalize` and `restore-schema` give back the file as the snapshot holds it, and finalizing again recreates the identical migration.
