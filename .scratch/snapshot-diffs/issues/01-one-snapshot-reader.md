# 01: One snapshot reader

**What to build:** Groundwork for storing snapshots as diffs (spec: `.scratch/snapshot-diffs/spec.md`, "Snapshot reader"). Every command that uses a migration's snapshot gets it from one store-level reader instead of reading the migration's snapshot folder itself, and the reader can give every snapshot of a history in one forward pass. It still reads the snapshot folders, so no behaviour changes: when ticket 03 switches the stored form, only the reader changes.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `draft`, `rehearse` (of the draft and of a finalized migration), `validate`, the deploy-time rule checks, `deploy`'s rehearsal, `unfinalize` and `restore-schema` all get snapshots from the reader. Nothing else reads a migration's snapshot.
- [ ] The reader gives the snapshot of the newest migration, of any given migration, and of every migration in a history in one pass. Commands that need several snapshots (`validate` checking every migration's rules) use the one-pass form.
- [ ] Before migration 1 the snapshot is the empty schema, as now.
- [ ] The existing test suite passes unchanged, and the example's `precommit` passes.
- [ ] Headers of the reader's module and of each changed command say where snapshots come from.
