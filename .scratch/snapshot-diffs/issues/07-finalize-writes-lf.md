# 07: Finalize writes every migration file with LF line endings

**What to build:** A developer who finalizes a draft saved with Windows line endings gets a migration (or Recovery) whose files are LF on disk from the moment they are written, on every machine, so a finalized file's bytes never depend on the editor or OS it came from. Hashes already ignore line endings, so nothing breaks today; this is about finalized files being as immutable as possible. The user's decision, made after ticket 06.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Every file `finalize` writes into a migration or Recovery folder (schema change, pre- and post-migration scripts, seed data, `metadata.json`, `HAND-EDITED.md`) has its line endings normalised to LF with the store's existing normalisation (a run of `\r` before `\n` becomes `\n`). Any other carriage return is content and stays.
- [ ] `desired-schema.diff` is not normalised: it is already written from normalised text, and a `\r` at the end of one of its lines can be content of the desired schema (ticket 06). It stays byte for byte.
- [ ] Content and chain hashes are unchanged by this: finalizing a CRLF draft and the same draft saved as LF gives byte-identical migrations and an identical `index.json`.
- [ ] `unfinalize`, then finalizing again, still recreates the identical migration.
- [ ] The template's `.gitattributes` keeps `HAND-EDITED.md` LF in every checkout (e.g. `*.md text eol=lf`), as it already does for `*.sql` and `*.json`.
- [ ] API tests: a draft whose scripts, seed data and hand-edited schema change are saved with CRLF finalizes to LF files (checked byte for byte, `HAND-EDITED.md` included); the same for a Recovery draft.
- [ ] The headers of finalize and the store's migration layout, and the template README where it describes finalized files, say that finalized files are written LF.
