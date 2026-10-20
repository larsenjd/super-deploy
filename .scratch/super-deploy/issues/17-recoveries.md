# 17: Recoveries

**What to build:** When a migration fails on real data, a developer creates a Recovery with replacement scripts, and targets that haven't run it get the Recovery instead, while every target ends with the same structure.

**Blocked by:** 07, 12

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] `recovery --migration N` creates a Recovery draft carrying N's schema change unchanged; refused while another draft exists.
- [ ] `finalize` freezes it under its migration and proves the structure matches the original's.
- [ ] `deploy` uses the newest Recovery for targets that haven't recorded N, and records the variant.
- [ ] Drift replay uses each target's recorded variant.
- [ ] `unfinalize` handles Recoveries.
