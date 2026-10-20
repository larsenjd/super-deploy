# 27: Reordered composite type attributes are caught

**What to build:** A desired schema that reorders a composite type's attributes is refused by the rehearsal, instead of passing while targets keep the old order. See GAPS.md "Attribute order of composite types".

**Blocked by:** None (can start immediately)

**Status:** resolved

**Spec:** `../spec.md` ("Supported object types", "Differ": verification independent of the differ)

- [ ] The catalog comparison (`verification/catalog.ts`) compares each composite type attribute's position among the type's live attributes. Table, view and other relation columns still ignore position.
- [ ] `rehearse` (and so `finalize`) refuses a draft whose desired schema reorders a composite type's attributes, naming the attributes whose position differs.
- [ ] Drift and `mark` pick it up through the shared comparison: a composite type reordered by hand on a target is drift.
- [ ] GAPS.md drops the entry once fixed; the pg-delta research §8 row says where it is handled.
