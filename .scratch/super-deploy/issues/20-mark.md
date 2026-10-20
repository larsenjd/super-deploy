# 20: Mark

**What to build:** After someone fixes a target by hand, a DBA records the next pending migration as deployed, but only if the target's structure matches exactly.

**Blocked by:** 12, 18

**Status:** ready-for-agent

**Spec:** `../spec.md`

- [ ] Only the target's next pending migration.
- [ ] Builds a locale-matched replica of migrations up to N; requires an empty diff, ignoring column order and ownership.
- [ ] Records the original variant, marked rather than deployed; writes only to the target's history schema; manual attempt under the OS username.
