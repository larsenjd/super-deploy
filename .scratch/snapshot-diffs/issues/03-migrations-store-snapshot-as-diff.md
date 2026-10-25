# 03: Migrations store their snapshot as `desired-schema.diff`

**What to build:** A developer who finalizes a migration gets one `desired-schema.diff` in the migration folder, a git-style diff from the previous migration's snapshot, instead of a full copy of the desired schema. Every command that uses a snapshot rebuilds it from the diffs and behaves as before, and `unfinalize` and `restore-schema` still give back the developer's files exactly. The example project's history is remade in the new form. See `.scratch/snapshot-diffs/spec.md` and ADR-0008.

**Blocked by:** 01 (one snapshot reader), 02 (multi-file diffs)

**Status:** resolved

- [ ] Finalize writes `desired-schema.diff` at the top of the migration folder, and no snapshot folder. It is the diff from the newest snapshot (the empty schema for migration 1) to the current desired schema, and is empty when the desired schema didn't change.
- [ ] Before anything is written or made read-only, finalize applies the diff to the newest snapshot and stops with an internal error, writing nothing, unless the result is exactly the current desired schema (line endings aside).
- [ ] The snapshot reader rebuilds snapshot N by applying diffs 1 to N. A diff that doesn't apply throws `SnapshotDiffDoesNotApplyError` naming the migration and the file, before the command writes anything.
- [ ] `unfinalize` leaves `desired-schema.diff` out of the draft and restores the migration's snapshot. Finalizing again recreates the identical migration, diff included.
- [ ] API tests: after several finalizes that add, edit, split and delete files in nested folders, with comments, override markers and a file without a trailing newline, `unfinalize` and `restore-schema` give back exactly those files. A script-only migration has an empty diff. `git apply` of a migration's diff onto the previous snapshot's files gives the desired schema it was finalized with.
- [ ] API tests: `rehearse` of an older migration, `validate` and `deploy` behave as before across a history of several migrations.
- [ ] Existing tests that read a migration's snapshot folder are rewritten to these behaviours. The full suite passes.
- [ ] The example's five migrations and Recovery are remade with the real CLI, keeping each migration's name, scripts, seed data and Recovery. The new tool can't read the old folders, so each migration is rebuilt from a copy of its old snapshot and scripts with `draft` and `finalize`. The example's `precommit` passes, including its history rehearsal.
- [ ] The example README shows `desired-schema.diff` wherever it described the snapshot folder.
- [ ] The headers of the store's migration layout, the snapshot reader, finalize and unfinalize describe the new form.
