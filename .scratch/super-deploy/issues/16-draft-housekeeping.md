# 16: Draft housekeeping

**What to build:** A developer can undo authoring mistakes safely with `unfinalize`, `restore-schema` and `discard-draft`.

**Blocked by:** 03

**Status:** resolved

**Spec:** `../spec.md`

- [ ] `unfinalize` moves the newest migration back into the draft, restores writable files, and restores the desired schema from that migration's own snapshot (the desired schema it was finalized from, not the snapshot of the migration before it), so finalizing again without edits reproduces the same migration.
- [ ] `restore-schema` resets the desired schema to the newest snapshot and deletes any draft.
- [ ] `discard-draft` deletes the draft and leaves the desired schema alone.
- [ ] Each asks before discarding work in a terminal, and requires `--acknowledge-overwrite` without one.
