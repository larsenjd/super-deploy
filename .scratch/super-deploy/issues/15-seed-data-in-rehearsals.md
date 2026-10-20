# 15: Seed data in rehearsals

**What to build:** A developer reproduces a production data problem with seed data, and the draft's rehearsals prove its scripts handle it.

**Blocked by:** 07

**Status:** resolved

**Spec:** `../spec.md`

- [ ] The draft's seed data loads just before its pre-migration script, in `draft`, `rehearse` and `finalize`.
- [ ] Frozen with the migration at finalize; never loaded when finalized migrations are replayed or in deployment rehearsals.
- [ ] Seed rules: `INSERT` with column lists only.
