# 07: Pre- and post-migration scripts

**What to build:** A developer renames a column in the pre-migration script and backfills data in the post-migration script. `draft` generates no drop-and-add for the rename, and `deploy` runs pre-migration script, schema change, then post-migration script for each pending migration.

**Blocked by:** 04, 06

**Status:** resolved

**Spec:** `../spec.md`

- [ ] `draft` diffs from (finalized migrations replayed plus the draft's pre-migration script) to the desired schema.
- [ ] `draft` reports what scripts still need to cover, e.g. a dropped column on a table with data.
- [ ] Each file runs as its own batch, so errors name the file.
- [ ] `SET CONSTRAINTS ALL IMMEDIATE` at each migration boundary.
- [ ] `CREATE TEMP TABLE … ON COMMIT DROP` staging works across a migration's scripts.
- [ ] Rehearsals run the scripts in the same order as deployments.
