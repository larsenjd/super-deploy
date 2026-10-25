# 04: Unknown and missing migration files are refused

**What to build:** A developer whose migration or Recovery folder holds a file it can't have, or is missing a file it must have, is told which file, by every command that verifies migrations, before any hash is compared. Today either shows only as a content-hash mismatch. Allowed and required files: `.scratch/snapshot-diffs/spec.md`, "Integrity".

**Blocked by:** 03 (`desired-schema.diff` becomes a required file, and the example must already be in the new form)

**Status:** resolved

- [ ] A file outside a migration folder's allowed set throws `UnknownMigrationFileError` (`unknown-migration-file`) naming its project-relative path. This includes dotfiles such as `.DS_Store`, a stray note, and a leftover snapshot folder from 0.3.0.
- [ ] A missing schema change, `metadata.json` or `desired-schema.diff` throws `MissingMigrationFileError` (`missing-migration-file`) naming its project-relative path.
- [ ] A Recovery folder is checked the same way against its own set: `metadata.json` required, and the pre- and post-migration scripts and seed data optional.
- [ ] Both checks run before content hashes in the integrity check, so every command that verifies migrations reports them. Both errors are exported from the public API.
- [ ] The allowed set is derived from the store's existing file-name constants, so adding a deploy-time file kind needs no second list.
- [ ] `finalize` refuses an unknown file in the draft folder (or a Recovery draft's) with `UnknownDraftFileError` (`unknown-draft-file`) naming its project-relative path, before it rehearses or writes anything, instead of copying it into the migration. `draft`, `rehearse` and `validate` keep their warning. (Added during implementation: the user's decision.)
- [ ] API tests cover each case above through at least one command, and the existing integrity tests still pass.
- [ ] The template README's description of integrity failures mentions both errors.
