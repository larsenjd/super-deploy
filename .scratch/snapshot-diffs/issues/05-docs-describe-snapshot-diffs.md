# 05: The user docs and code map describe snapshot diffs

**What to build:** A newcomer reading the user documentation, and an agent reading the code map, find the snapshot described as it now is on disk: one `desired-schema.diff` per migration, a diff from the previous migration's snapshot. See `.scratch/snapshot-diffs/spec.md` and ADR-0008.

**Blocked by:** 03 (migrations store their snapshot as `desired-schema.diff`)

**Status:** resolved

- [ ] The template README describes a migration's snapshot as a diff from the previous one wherever it mentions the snapshot folder: the migration layout, `unfinalize`, `restore-schema`, and what an edited migration looks like.
- [ ] The code map names the snapshot reader and where the diff format lives.
- [ ] Nothing in the user docs, the code map or the agent docs still describes a snapshot folder inside a migration.
