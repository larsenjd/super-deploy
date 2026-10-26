# Snapshots stored as diffs

**Status:** resolved

Decision and rejected alternatives: ADR-0008. Term: **Snapshot** in `GLOSSARY.md`.

## Problem Statement

Every migration keeps its snapshot as a full copy of the desired-schema files. Each new migration repeats the whole desired schema, even when it changes one line. A developer's migrations folder grows by a schema's worth of files with every migration. A reviewer opening a migration's pull request sees the entire desired schema as newly added files and has to hunt for the part that actually changed.

## Solution

Each migration keeps its snapshot as one diff from the previous migration's snapshot, in the same format `git diff` writes. A migration's pull request then shows the desired-schema change as a small, highlighted diff. super-deploy rebuilds any snapshot by applying the diffs in order, so every command that uses a snapshot behaves as before. `unfinalize` and `restore-schema` still give the developer back their own files exactly: names, folders, comments, override markers and formatting.

Migration folders also become strict about their contents. A file a migration can't have, or a missing file it must have, is refused with an error naming the file, instead of showing up only as a vague integrity failure.

## User Stories

1. As a developer, I want finalize to store only what changed in the desired schema since the previous migration, so that my migrations folder doesn't grow by a full copy of the schema each time.
2. As a reviewer, I want a migration's desired-schema change shown as one diff, so that I can see what changed in the desired schema without comparing whole files.
3. As a reviewer, I want that diff in the format `git diff` writes, so that GitHub and my editor highlight it and I read it like any other diff.
4. As a developer, I want the diff to list changed, added and deleted desired-schema files, so that renaming, splitting or removing a file is recorded as well as edits inside files.
5. As a developer, I want the file paths in the diff to be relative to my desired-schema folder, so that they read the same as the paths I edit.
6. As a developer, I want the first migration's diff to add every desired-schema file, so that the first migration is like any other.
7. As a developer, I want a migration that changes only scripts to still have a desired-schema diff, left empty, so that every migration has the same files and a reviewer sees that nothing changed.
8. As a developer, I want my comments, override markers, blank lines and formatting in the desired schema kept exactly, so that nothing I wrote is lost or rearranged.
9. As a developer, I want my desired-schema files split however I like, in any folders, so that storing diffs doesn't constrain how I organise the schema.
10. As a developer, I want a file without a trailing newline recorded as such, so that getting it back gives the same file.
11. As a developer with files saved with Windows line endings, I want the snapshot to treat line endings as it does today, so that line endings alone are never a change.
12. As a developer, I want finalize to check that the diff it wrote rebuilds exactly my current desired schema before the migration becomes read-only, so that a broken diff can never be finalized.
13. As a developer, I want finalize to write nothing if that check fails, so that a failure leaves my project as it was.
14. As a developer, I want `unfinalize` to put back exactly the desired-schema files of the migration it takes back, so that I can carry on editing where I was.
15. As a developer, I want `unfinalize` to leave the desired-schema diff out of the draft, so that the draft holds only what I author.
16. As a developer, I want finalizing again after `unfinalize` to recreate the identical migration, including its diff, so that unfinalize and finalize stay inverses.
17. As a developer, I want `restore-schema` to reset my desired schema to exactly the newest snapshot, bringing back deleted files and removing files the snapshot doesn't have, so that it behaves as it does today.
18. As a developer, I want `draft` to check deploy-time rules against the newest snapshot as it does today, so that storing diffs changes no rule outcome.
19. As a developer, I want `rehearse` of an older migration to use the snapshots on either side of it, so that its rule checks still tell a lossy type change from a widening.
20. As a developer, I want `validate` to report a desired schema that differs from the newest snapshot with no draft covering it, as it does today.
21. As an operator, I want `deploy`'s rehearsal to compare its result with the newest snapshot as before, so that a deployment that wouldn't reach the desired schema is still refused.
22. As a developer with a long history, I want commands that need many snapshots to rebuild them quickly, so that storing diffs doesn't make commands noticeably slower.
23. As a developer, I want a migration folder holding a file it can't have, such as `.DS_Store` or a stray note, refused with an error naming that file, so that I know exactly what to remove.
24. As a developer, I want a migration folder missing a file it must have refused with an error naming that file, so that I know what to restore from version control.
25. As a developer, I want these refusals made before any hash is compared, by every command that verifies migrations, so that I get the clear message instead of a hash mismatch.
26. As a developer, I want a Recovery folder held to the same rule, with its own set of allowed files, so that Recoveries are checked as strictly as migrations.
27. As a developer, I want a migration folder with a desired-schema folder in it (from 0.3.0 and earlier) refused as an unknown file, so that an old-format migration is never silently read as an empty snapshot.
28. As a developer, I want a diff that doesn't apply refused with an error naming the migration and the file, before the command writes anything, so that a broken history never corrupts my desired schema.
29. As an API user, I want the new errors exported with stable codes (`unknown-migration-file`, `missing-migration-file`, `snapshot-diff-does-not-apply`), so that I can handle them like every other super-deploy error.
30. As a newcomer reading the example project, I want its history to show `desired-schema.diff` in every migration, so that the example matches what my own project gets.
31. As a newcomer, I want the user documentation to describe a migration's snapshot as a diff from the previous one, so that the docs match what I see on disk.
32. As a maintainer, I want one place that rebuilds snapshots, so that no command reads a migration's snapshot any other way.
33. As a maintainer, I want the allowed files of a migration folder derived from the same names the rest of the store uses, so that adding a deploy-time file kind doesn't mean updating a second list.

## Implementation Decisions

- **Stored form.** Each migration folder has one file, `desired-schema.diff`, at its top level in place of the snapshot folder. It is a multi-file diff of the `.sql` files in the desired-schema folder against the previous migration's snapshot (an empty schema for migration 1), and is always written, empty when nothing changed. It is part of the migration's content hash like every other file in it.
- **Format.** As close to `git diff` as possible: `--- a/<path>` / `+++ b/<path>` headers with paths relative to the desired-schema folder, `/dev/null` on one side for an added or deleted file, three lines of context, files in path order, and `\ No newline at end of file` where needed. Line endings are normalised once before diffing, by the store's one rule: a run of carriage returns before a line feed becomes the line feed, so normalising twice changes nothing (ticket 06). Any other carriage return is content, so a diff line can end in one; the diff is therefore stored byte for byte, and projects mark it `-text` in `.gitattributes` so git never converts it. The existing unified-diff module, which writes the hand-edit report and reverses it for unfinalize, grows a multi-file writer and a strict forward applier: every context and removed line must match, with no fuzz. The applier reads the diff as written, except that it undoes a whole-file CRLF conversion by a checkout.
- **Snapshot reader.** One store-level reader rebuilds snapshot N by applying diffs 1 to N to an empty schema, and can give every snapshot of a history in one forward pass. Every command that reads a snapshot today (`draft`, `rehearse`, `validate`, the deploy-time rule checks, `deploy`'s rehearsal, `unfinalize`, `restore-schema`) goes through it. It works on migrations that have already passed the integrity check.
- **Finalize.** It writes the diff between the newest snapshot and the current desired schema, applies it to the newest snapshot, and stops with an internal error unless the result is exactly the current desired schema, line endings aside. All of this happens before anything is written or made read-only. Every file finalize writes into a migration or Recovery folder is LF, except `desired-schema.diff`, which is written byte for byte (ticket 07); hashes already ignore line endings, so a CRLF draft and an LF draft finalize to identical migrations. The template's `.gitattributes` keeps `.sql`, `.json` and `.md` files LF in every checkout.
- **Unfinalize and restore-schema.** Same behaviour as now, with the snapshot coming from the reader. `unfinalize` leaves `desired-schema.diff` out of the draft, as it leaves out `metadata.json` and `HAND-EDITED.md`.
- **Integrity.** Before content hashes are compared, the integrity check refuses any file outside a folder's allowed set, dotfiles included, with `UnknownMigrationFileError` (`unknown-migration-file`), and a missing required file with `MissingMigrationFileError` (`missing-migration-file`). Each names the project-relative path. A migration's required files are the schema change, metadata and desired-schema diff; its optional ones are the pre- and post-migration scripts, seed data and the hand-edit report. A Recovery requires metadata and allows the two scripts and seed data. The allowed set is derived from the store's existing file-name constants.
- **Unknown draft files.** Because a migration folder now refuses unknown files, `finalize` refuses an unknown file in the draft folder (such as a misnamed `post-migrate.sql`) with `UnknownDraftFileError` (`unknown-draft-file`), naming its project-relative path, before it rehearses or writes anything, instead of copying it into the migration. A Recovery draft follows the same rule with its own allowed files. `draft`, `rehearse` and `validate` keep their warning.
- **Diff that doesn't apply.** `SnapshotDiffDoesNotApplyError` (`snapshot-diff-does-not-apply`) names the migration and the file whose hunk failed. It is thrown by the snapshot reader, which turns the diff module's generic mismatch into it, before the command writes anything or touches a target.
- **Recovery drafts.** A Recovery draft has its own allowed files: its bookkeeping file, the schema change and the files a Recovery replaces. `draft`, `rehearse` and `validate` warn about anything else, and `finalize` refuses it.
- **Removed problem code.** `validate`'s `schema-change-missing` problem is replaced by `missing-migration-file`, and finalize's `onUnknownFile` option is removed, since finalize now refuses unknown draft files.
- **Errors.** All three are `SuperDeployError` subclasses, live in the module that throws them, have one-line messages with project-relative paths, and are exported from the public API.
- **No compatibility.** Snapshot folders from 0.3.0 and earlier are not read; such a folder is an unknown file. No project used the library yet.
- **Example and docs.** The example's history (five migrations and a Recovery) is remade with the real CLI, as a user would. The example README, the template README, the code map and the headers of every touched store and command module describe the new form.

## Testing Decisions

- A good test drives the feature the way a developer does and checks what they would see: files on disk, command results and typed errors. It never checks how the snapshot is rebuilt.
- **API seam (main seam).** Integration tests import `superdeploy`, build a temp project and run commands, as the existing finalize and housekeeping tests do. They cover:
  - finalize writes `desired-schema.diff` and no snapshot folder, the diff is empty for a script-only migration, and `git apply` of the diff onto the previous snapshot's files gives the current desired schema;
  - after several finalizes that add, edit, split and delete files in nested folders, with comments, override markers and a file without a trailing newline, `unfinalize` and `restore-schema` give back those files exactly, and finalizing again after `unfinalize` recreates the identical migration;
  - `rehearse` of an older migration, `validate` and `deploy` behave as now across a history of several migrations;
  - a stray `.DS_Store`, a stray file in a Recovery, a leftover snapshot folder and a missing required file are each refused with their error, naming the file.
  Existing tests that read a migration's snapshot folder are rewritten to these behaviours.
- **Unit seam (diff module only).** Database-free tests import the diff module directly, as the SQL-analysis tests import their module. They cover the writer and applier's edge cases: no trailing newline, CRLF input, empty files, a file deleted and another added at the same path, many hunks in one file, and round trips. They also cover the diff module's generic mismatch error, by applying a diff to text it doesn't match. The public `SnapshotDiffDoesNotApplyError` is only reachable with a migration folder and `index.json` edited together, so it is tested where the final review's fixes found a seam for it.
- **The CLI seam** gets no new tests: nothing changes at the process boundary.
- **The example's `precommit`**, which deploys the whole history to a throwaway database through the public API, must pass on the remade history.

## Out of Scope

- Normalizing, reordering or merging the desired schema before diffing (ADR-0008).
- Periodic full snapshots.
- Reading or converting migrations with a snapshot folder from 0.3.0 and earlier.
- Showing the pending desired-schema diff in the draft before finalize.
- Releasing a new version.

## Further Notes

- Reading any snapshot reads every migration before it. That is acceptable because every command already verifies the whole hash chain.
- Diffs are only ever applied to migrations that passed the integrity check. So `snapshot-diff-does-not-apply` means a bug in the diff module, or a migration folder and `index.json` edited together.
